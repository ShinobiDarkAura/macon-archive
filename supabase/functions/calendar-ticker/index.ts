// Maçon Archive — calendar ticker proxy
// Fetches the private Apple Calendar (iCloud) public-share .ics feed and returns
// a window of events (each tagged with its date) as JSON, CORS open for the app.
// Note: one-off events only — recurring (RRULE) events surface on their first date.
//
// Setup (Supabase Dashboard):
//   1. Edge Functions → Deploy new function → name: calendar-ticker → paste this file.
//   2. Edge Functions → calendar-ticker → Secrets → add:
//        ICS_URL = https://p##-caldav.icloud.com/published/2/...   (your webcal:// URL with webcal:// swapped for https://)
//   3. Function settings → disable "Enforce JWT verification" (the feed is read-only and contains only event titles/times).

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const icsUrl = Deno.env.get("ICS_URL");
  if (!icsUrl) {
    return new Response(JSON.stringify({ error: "ICS_URL secret not set" }), {
      status: 500, headers: { ...cors, "content-type": "application/json" },
    });
  }

  const res = await fetch(icsUrl.replace(/^webcal:/, "https:"));
  if (!res.ok) {
    return new Response(JSON.stringify({ error: "feed fetch failed: " + res.status }), {
      status: 502, headers: { ...cors, "content-type": "application/json" },
    });
  }
  const ics = await res.text();

  // A window of days around today, in the calendar's display timezone.
  const tz = Deno.env.get("TICKER_TZ") || "Europe/London";
  const PAST_DAYS = 7, AHEAD_DAYS = 45;
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const [Y, M, D] = todayStr.split("-").map(Number);
  const baseUTC = Date.UTC(Y, M - 1, D, 12);
  const lowStr = new Date(baseUTC - PAST_DAYS * 86400000).toISOString().slice(0, 10);
  const highStr = new Date(baseUTC + AHEAD_DAYS * 86400000).toISOString().slice(0, 10);
  const DAY = 86400000;
  const ymdToUTC = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d, 12); };
  const utcToYmd = (ts: number) => new Date(ts).toISOString().slice(0, 10);

  // --- minimal ICS parse: unfold lines, walk VEVENTs ---
  const lines = ics.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  type Ev = { date: string; title: string; start: string; allDay: boolean };
  const events: Ev[] = [];
  let cur: Record<string, string> | null = null;
  for (const ln of lines) {
    if (ln === "BEGIN:VEVENT") cur = {};
    else if (ln === "END:VEVENT") { if (cur) finish(cur); cur = null; }
    else if (cur) {
      const i = ln.indexOf(":");
      if (i > 0) {
        const key = ln.slice(0, i).split(";")[0];
        if (key === "EXDATE") cur["EXDATE"] = (cur["EXDATE"] ? cur["EXDATE"] + "," : "") + ln.slice(i + 1);
        else cur[key] = ln.slice(i + 1);
      }
      if (ln.startsWith("DTSTART;VALUE=DATE:")) cur["ALLDAY"] = "1";
      if (ln.startsWith("DTSTART;") && ln.includes("TZID=")) cur["TZID"] = ln.slice(8, ln.indexOf(":")).replace(/.*TZID=/, "");
    }
  }
  function finish(c: Record<string, string>) {
    const raw = c["DTSTART"]; if (!raw || !c["SUMMARY"]) return;
    const allDay = !!c["ALLDAY"] || !raw.includes("T");
    let evDate0: string, start = "";
    if (allDay) {
      evDate0 = raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);
    } else {
      const when = raw.endsWith("Z")
        ? new Date(raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))
        : new Date(raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6"));
      evDate0 = when.toLocaleDateString("en-CA", { timeZone: tz });
      start = when.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    }
    const title = c["SUMMARY"].replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " · ");

    // exception dates (cancelled instances of a recurring event)
    const exSet = new Set<string>();
    if (c["EXDATE"]) for (const m of c["EXDATE"].matchAll(/(\d{4})(\d{2})(\d{2})/g)) exSet.add(`${m[1]}-${m[2]}-${m[3]}`);

    const emit = (ymd: string) => {
      if (ymd < lowStr || ymd > highStr || exSet.has(ymd)) return;
      events.push({ date: ymd, title, start, allDay });
    };

    const rrule = c["RRULE"];
    if (!rrule) { emit(evDate0); return; }

    // --- expand a recurring event across the window ---
    const R: Record<string, string> = {};
    for (const part of rrule.split(";")) { const [k, v] = part.split("="); if (k) R[k] = v; }
    const freq = R["FREQ"];
    const interval = Math.max(1, parseInt(R["INTERVAL"] || "1", 10));
    const count = R["COUNT"] ? parseInt(R["COUNT"], 10) : null;
    const untilM = (R["UNTIL"] || "").match(/^(\d{4})(\d{2})(\d{2})/);
    const untilYmd = untilM ? `${untilM[1]}-${untilM[2]}-${untilM[3]}` : null;
    const stopYmd = untilYmd && untilYmd < highStr ? untilYmd : highStr;
    const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const start0 = ymdToUTC(evDate0);
    let n = 0, iter = 0;

    if (freq === "WEEKLY" && R["BYDAY"]) {
      const days = R["BYDAY"].split(",").map((d) => WD[d.slice(-2)]).filter((x) => x != null);
      let weekStart = start0 - new Date(start0).getUTCDay() * DAY;
      while (iter++ < 5000) {
        for (const dow of days) {
          const occ = weekStart + dow * DAY;
          const ymd = utcToYmd(occ);
          if (occ < start0 || ymd > stopYmd) continue;
          if (count && n >= count) break;
          emit(ymd); n++;
        }
        weekStart += interval * 7 * DAY;
        if (utcToYmd(weekStart) > stopYmd || (count && n >= count)) break;
      }
    } else {
      let occ = start0;
      while (iter++ < 5000) {
        const ymd = utcToYmd(occ);
        if (ymd > stopYmd || (count && n >= count)) break;
        emit(ymd); n++;
        const dt = new Date(occ);
        if (freq === "DAILY") occ += interval * DAY;
        else if (freq === "WEEKLY") occ += interval * 7 * DAY;
        else if (freq === "MONTHLY") occ = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + interval, dt.getUTCDate(), 12);
        else if (freq === "YEARLY") occ = Date.UTC(dt.getUTCFullYear() + interval, dt.getUTCMonth(), dt.getUTCDate(), 12);
        else break; // unknown freq: only the first occurrence
      }
    }
  }

  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay ? "" : a.start).localeCompare(b.allDay ? "" : b.start) ||
    a.title.localeCompare(b.title));
  return new Response(JSON.stringify({ date: todayStr, events }), {
    headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
});

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
      if (i > 0) cur[ln.slice(0, i).split(";")[0]] = ln.slice(i + 1);
      if (ln.startsWith("DTSTART;VALUE=DATE:")) cur["ALLDAY"] = "1";
      if (ln.startsWith("DTSTART;") && ln.includes("TZID=")) cur["TZID"] = ln.slice(8, ln.indexOf(":")).replace(/.*TZID=/, "");
    }
  }
  function finish(c: Record<string, string>) {
    const raw = c["DTSTART"]; if (!raw || !c["SUMMARY"]) return;
    const allDay = !!c["ALLDAY"] || !raw.includes("T");
    let evDate: string, start = "";
    if (allDay) {
      evDate = raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);
    } else {
      const when = raw.endsWith("Z")
        ? new Date(raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))
        : new Date(raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6"));
      evDate = when.toLocaleDateString("en-CA", { timeZone: tz });
      start = when.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    }
    if (evDate < lowStr || evDate > highStr) return;   // keep only the window
    events.push({
      date: evDate,
      title: c["SUMMARY"].replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " · "),
      start,
      allDay,
    });
  }

  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay ? "" : a.start).localeCompare(b.allDay ? "" : b.start) ||
    a.title.localeCompare(b.title));
  return new Response(JSON.stringify({ date: todayStr, events }), {
    headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
});

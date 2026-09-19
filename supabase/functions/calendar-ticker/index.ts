// Maçon Archive — calendar ticker proxy
// Fetches the private Apple Calendar (iCloud) public-share .ics feed and returns
// a window of events (each tagged with its date) as JSON, to signed-in keepers.
// Event titles name people ("Respond Rami"), so it is not public.
//
// DEPLOY WITH --no-verify-jwt: the keeper check below replaces the gateway's.
//
// Setup (Supabase Dashboard):
//   1. Edge Functions → Deploy new function → name: calendar-ticker → paste this file.
//   2. Edge Functions → calendar-ticker → Secrets → add:
//        ICS_URL = https://p##-caldav.icloud.com/published/2/...   (your webcal:// URL with webcal:// swapped for https://)
//   3. Function settings → disable "Enforce JWT verification" (the feed is read-only and contains only event titles/times).

import { keeperEmail, sameSecret } from "../_shared/keepers.ts";

/* Reading the calendar: the window of days, every event in it, repeats
   expanded, moved instances honoured, in the studio's own time zone.
   Used by the ticker itself and by the ?check= health check, so what the
   check reports is exactly what the desk is served. */
function readFeed(ics: string, tz: string) {
  // A window of days around today, in the studio's own time zone.
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

  /* A calendar time is written in some zone: the event's own TZID, UTC when it
     ends in Z, or the calendar's. Read as if it were UTC (which is what the
     runtime does with a bare string) a 5pm Los Angeles event became 1am the
     next day in London, and moved to the wrong day. */
  const zoneOffset = (ms: number, zone: string) => {
    const d = new Date(ms);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(d).reduce((o: Record<string, string>, x) => (o[x.type] = x.value, o), {});
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUTC - ms;
  };
  const instantOf = (raw: string, zone: string): number => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(raw.trim());
    if (!m) return NaN;
    const [, y, mo, d, h = "12", mi = "00", se = "00", z] = m;
    const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    if (z) return naive;                                  // already UTC
    let ms = naive - zoneOffset(naive, zone);             // the zone's wall clock
    ms = naive - zoneOffset(ms, zone);                    // settle across a DST edge
    return ms;
  };
  const ymdIn = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });

  // Helper: parse a DTSTART/RECURRENCE-ID raw value to a YYYY-MM-DD string.
  const rawToYmd = (raw: string, zone = tz): string => {
    if (!raw.includes("T")) return raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);   // all-day
    const ms = instantOf(raw, zone);
    return isNaN(ms) ? raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8) : ymdIn(ms);
  };

  // --- Phase 1: collect all VEVENTs into an array ---
  const lines = ics.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  type Ev = { date: string; title: string; start: string; allDay: boolean };
  const events: Ev[] = [];
  const vevents: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;

  for (const ln of lines) {
    if (ln === "BEGIN:VEVENT") { cur = {}; }
    else if (ln === "END:VEVENT") { if (cur) vevents.push(cur); cur = null; }
    else if (cur) {
      const i = ln.indexOf(":");
      if (i > 0) {
        const key = ln.slice(0, i).split(";")[0];
        if (key === "EXDATE") cur["EXDATE"] = (cur["EXDATE"] ? cur["EXDATE"] + "," : "") + ln.slice(i + 1);
        else cur[key] = ln.slice(i + 1);
      }
      if (ln.startsWith("DTSTART;VALUE=DATE:")) cur["ALLDAY"] = "1";
      if (ln.startsWith("DTSTART;") && ln.includes("TZID=")) cur["TZID"] = ln.slice(8, ln.indexOf(":")).replace(/.*TZID=/, "");
      // Capture RECURRENCE-ID (the original date of a moved/edited recurring instance)
      if (ln.startsWith("RECURRENCE-ID")) cur["RECURRENCE-ID"] = ln.slice(ln.indexOf(":") + 1);
    }
  }

  // --- Phase 2: build override map  uid → Set<original-ymd> ---
  // A VEVENT with RECURRENCE-ID is an override for one specific instance of a recurring
  // series. We record its original date so the master RRULE expansion can skip it.
  const overrideMap = new Map<string, Set<string>>();
  for (const c of vevents) {
    const uid = c["UID"];
    const recId = c["RECURRENCE-ID"];
    if (!uid || !recId) continue;
    const ymd = rawToYmd(recId, c["TZID"] || tz);
    if (!overrideMap.has(uid)) overrideMap.set(uid, new Set());
    overrideMap.get(uid)!.add(ymd);
  }

  // --- Phase 3: emit events ---
  function finish(c: Record<string, string>, overriddenDates: Set<string>) {
    const raw = c["DTSTART"]; if (!raw || !c["SUMMARY"]) return;
    const allDay = !!c["ALLDAY"] || !raw.includes("T");
    let evDate0: string, start = "";
    if (allDay) {
      evDate0 = raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);
    } else {
      const ms = instantOf(raw, c["TZID"] || tz);
      if (isNaN(ms)) return;
      const when = new Date(ms);
      evDate0 = when.toLocaleDateString("en-CA", { timeZone: tz });
      start = when.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    }
    // A title is what it says, without the trailing spaces that made one event
    // look like two on the day's list.
    const title = c["SUMMARY"].replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " · ").replace(/\s+/g, " ").trim();
    if (c["STATUS"] === "CANCELLED") return;

    // Exception dates (cancelled instances)
    const exSet = new Set<string>();
    if (c["EXDATE"]) for (const m of c["EXDATE"].matchAll(/(\d{4})(\d{2})(\d{2})/g)) exSet.add(`${m[1]}-${m[2]}-${m[3]}`);

    const emit = (ymd: string) => {
      if (ymd < lowStr || ymd > highStr || exSet.has(ymd)) return;
      // Skip original slots that have been superseded by a RECURRENCE-ID override
      if (overriddenDates.has(ymd)) return;
      events.push({ date: ymd, title, start, allDay });
    };

    // Override VEVENTs (have RECURRENCE-ID) carry their own DTSTART (the new slot).
    // They have no RRULE; emit once at the new date and return.
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

  /* A moved or edited instance of a repeating event is itself a VEVENT with a
     RECURRENCE-ID. The series skips the date it replaces, but the replacement
     must not: it used to skip its own date and vanish, which is why a changed
     event only appeared after being deleted and added again. */
  for (const c of vevents)
    finish(c, c["RECURRENCE-ID"] ? new Set<string>() : (overrideMap.get(c["UID"] ?? "") ?? new Set<string>()));

  // One entry per event: a feed can carry the same occurrence more than once.
  const seenEv = new Set<string>();
  const unique = events.filter((e) => { const k = `${e.date}|${e.start}|${e.title}`; if (seenEv.has(k)) return false; seenEv.add(k); return true; });
  events.length = 0; events.push(...unique);

  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay ? "" : a.start).localeCompare(b.allDay ? "" : b.start) ||
    a.title.localeCompare(b.title));
  return { date: todayStr, events };
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // A health check for the feed itself: counts only, never the calendar's
  // address or what is in it. Answers to the digest key, so it can be checked
  // without signing in when the ticker looks stuck.
  if (new URL(req.url).searchParams.has("check") && sameSecret(req.headers.get("x-digest-key"), Deno.env.get("DIGEST_KEY") || "")) {
    const url = Deno.env.get("ICS_URL");
    if (!url) return new Response(JSON.stringify({ feed: "no ICS_URL set" }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    try {
      const r = await fetch(url.replace(/^webcal:/, "https:"));
      const body = r.ok ? await r.text() : "";
      const events = (body.match(/BEGIN:VEVENT/g) || []).length;
      const stamps = [...body.matchAll(/DTSTART[^:]*:(\d{8})/g)].map((m) => m[1]).sort();
      const day = new URL(req.url).searchParams.get("day");     // YYYY-MM-DD, what the feed holds that day
      const raw: string[] = [];
      if (day) {
        const ymd = day.replace(/-/g, "");
        for (const block of body.split("BEGIN:VEVENT").slice(1)) {
          const v = block.split("END:VEVENT")[0];
          if (!v.includes(ymd) && !/RRULE/.test(v)) continue;
          const line = (k: string) => (v.match(new RegExp("^" + k + "[^\\r\\n]*", "m")) || [])[0]?.trim() || "";
          raw.push([line("SUMMARY"), line("DTSTART"), line("RRULE"), line("STATUS"), line("RECURRENCE-ID")].filter(Boolean).join("  ||  "));
        }
      }
      return new Response(JSON.stringify({ feed: r.status, bytes: body.length, events,
        firstDate: stamps[0] || null, lastDate: stamps[stamps.length - 1] || null,
        calendarName: (body.match(/^X-WR-CALNAME:(.*)$/m) || [])[1]?.trim() || null,
        feedTimezone: (body.match(/^X-WR-TIMEZONE:(.*)$/m) || [])[1]?.trim() || null,
        tickerTimezone: Deno.env.get("TICKER_TZ") || "Europe/London (default)",
        crlf: body.includes("\r\n"), folded: /\r?\n[ \t]/.test(body),
        cancelled: (body.match(/STATUS:CANCELLED/g) || []).length,
        day, onThatDay: raw.slice(0, 40),
        asServed: day ? readFeed(body, Deno.env.get("TICKER_TZ") || "America/Los_Angeles").events.filter((e) => e.date === day) : undefined,
      }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ feed: "fetch failed", error: String(e) }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    }
  }
  if (!(await keeperEmail(req)))
    return new Response(JSON.stringify({ error: "keepers only" }), { status: 401, headers: { ...cors, "content-type": "application/json" } });

  const icsUrl = Deno.env.get("ICS_URL");
  if (!icsUrl) {
    return new Response(JSON.stringify({ error: "ICS_URL secret not set" }), {
      status: 500, headers: { ...cors, "content-type": "application/json" },
    });
  }

  // Never a cached copy: a stale snapshot is what made a new event show up
  // only after it was deleted and added again.
  const res = await fetch(icsUrl.replace(/^webcal:/, "https:"), { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    return new Response(JSON.stringify({ error: "feed fetch failed: " + res.status }), {
      status: 502, headers: { ...cors, "content-type": "application/json" },
    });
  }
  const ics = await res.text();
  const tz = Deno.env.get("TICKER_TZ") || "America/Los_Angeles";   // where the studio is

  return new Response(JSON.stringify(readFeed(ics, tz)), {
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });
});

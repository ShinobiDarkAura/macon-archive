# Maçon Archive — Session Handoff

## Project Overview

**Maçon Archive** is a single-file collector CRM for a handmade bronze studio (Maçon, by Alex Cohen & Hannah Woodard). It is a static web app (`index.html`) deployed on GitHub Pages, backed by Supabase with realtime sync.

- **Live URL:** https://shinobidarkaura.github.io/macon-archive/
- **Repo:** GitHub, committed as ShinobiDarkAura / sobriquet@cartridge.gg
- **Supabase project ref:** `berdrzxjoejirbhdgjer`
- **Auth:** email+password, only `alex@studiomacon.co` and `hannah@studiomacon.co` can sign in (RLS-enforced)
- **Anon key:** intentionally public, all access gated by RLS keepers-only policy

---

## Tech Stack

- **Frontend:** single `index.html` — vanilla JS, no build step, no frameworks
- **Backend:** Supabase (Postgres + RLS + Realtime + Edge Functions)
- **Edge Functions** (Deno/TypeScript, deployed via Supabase CLI at `~/.local/bin/supabase`):
  - `calendar-ticker` — proxies iCloud .ics feed, expands RRULE recurrences, returns 7-day-back/45-day-ahead JSON
  - `wix-order` — receives Wix "order placed" webhooks, upserts collectors idempotently
  - `followup-digest` — weekly emailed digest of due follow-ups via Resend API (scheduled via pg_cron)
- **Supabase CLI:** v2.105.0, installed as binary at `~/.local/bin/supabase` (brew failed on macOS 26 due to CLT incompatibility)

---

## Design System

| Token | Value |
|---|---|
| `--ink` | `#2b2622` |
| `--paper` | `#f4efe4` |
| `--bronze` | `#8c6a47` |
| `--seal` | `#9c4a3a` |
| Display/numbers | Louize |
| Serif/italic | EB Garamond |
| Sans | Inter |
| Mono | DM Mono |

---

## Database Schema (key columns)

**`collectors` table:**
`acc` (M-001 format PK), `name`, `email`, `phone`, `instagram`, `location`, `pieces` (comma-separated e.g. "Pip ×2, Arc"), `ltv` (numeric), `gift_self` ("Self"/"Gift"), `signal` ("Hi"/"Med"/"Low"), `story` ("Asked"/"Yes"/null), `first_look` (bool, VIP flag), `first_buy`, `last_buy`, `last_contact` (dates YYYY-MM-DD), `notes`

**`bureau_todos` table:**
`id` (text PK), `done_at`, `done_by` — synced via Supabase Realtime, RLS keepers-only

**`processed_orders` table:**
`id` (text PK), `email`, `total`, `applied_at` — idempotency for Wix webhook

---

## Key Business Logic (JS in index.html)

**Follow-up due logic:**
- Eligible: `last_buy` set + `daysSince(last_buy) >= leadTime(pieces)` + `story !== "Yes"` + not recently contacted since last buy
- `PIECE_LEAD` map per piece name (e.g. Pip=14 days), `LEAD_DEFAULT=21`
- Settle buffer: `+14` days on top of lead time
- Snooze: 21 days after `last_contact` if contacted post-purchase
- Reconnect type: VIPs with `daysSince(last_buy) > 365` surface as "Reconnect" follow-ups
- Score/priority: `first_look +3`, `ltv>1000 +2`, repeat buyer +1, gift +1 → High(≥3), Med(≥1), Low

**True Collector definition:** `countPieces >= 2 AND daysSince(last_buy) <= 548`

**`clientType(d)`:** returns "VIP" / "Collector" / "Gift" / "New"

**`shortName(n)`:** "Hannah Woodard" → "Hannah W."

**`followKey(d, kind)`:** returns chip CSS class key: `vip`, `reconnect`, `repeat`, `gift`, `value`, `first`

**`cardMeta(d, kind)`:** formats follow-up action + piece count + LTV for drawer card metadata line

**Jewelry detection:** `CHARACTER_PIECES` list + regex for ring/arc/key/horn patterns (for template personalization)

---

## UI Structure

- **Left column:** stats (True Collectors, LTV, Pieces Sold, etc.) + progress bars + funnel readout + Broadcast Compose button + Todolist
- **Main area:** sortable/filterable collector table with avatar thumbnails (monochrome warm-tinted by default, full color on hover)
- **Right drawer** (dark, floating, inset 24px from edges): follow-up cards, sorted by priority, collapsible
- **Tabs:** "True Collectors" / "All Collectors" under the True Collectors stat card
- **Bureau of Provenance tab:** editorial gallery of collector stories
- **Calendar ticker:** floating popup from a date widget, pulls from iCloud via Edge Function
- **Modals:** Edit collector, New entry, Draft email, Broadcast compose — all use `.scrim/.card` pattern

---

## Follow-Up Drawer (current CSS state)

```css
.drawer {
  position: fixed; top: 24px; right: 24px;
  height: calc(100vh - 48px); width: 404px;
  background: rgba(20,17,14,.92);
  backdrop-filter: blur(14px) saturate(1.1);
  border-radius: 16px; overflow: hidden;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
  z-index: 45; display: flex; flex-direction: column;
  transform: translateX(0); transition: transform .28s ease;
}
body.drawer-collapsed .drawer { transform: translateX(calc(100% + 28px)); }
body { transition: padding-right .28s ease; padding-right: 440px; }

.fcard {
  display: flex; flex-direction: row; gap: 0; flex: 0 0 auto;
  border: none; border-radius: 12px;
  background: rgba(255,255,255,.055);
  box-shadow: 0 6px 18px rgba(0,0,0,.42);
  position: relative; cursor: pointer;
  transition: box-shadow .18s ease, transform .2s ease;
}
.fcard.important { background: rgba(255,255,255,.1); }

/* Red "important" dot badge */
.fimp {
  position: absolute; top: -4px; right: -4px;
  width: 11px; height: 11px; border-radius: 50%;
  background: #d4453a; z-index: 6;
  box-shadow: 0 0 0 2.5px #26221d, 0 1px 4px rgba(212,69,58,.55);
}
```

> **Known issue / recent complaint:** The ring around the red dot (currently `#26221d`) still appears too black against the rendered drawer surface. The drawer is `rgba(20,17,14,.92)` composited over `#f4efe4` paper, which renders as a warm dark brown (~`#2a2019`). The ring color may need to go lighter, e.g. `#3a3028` or `#443830`, to visibly read as warm brown rather than black. The user has flagged this multiple times.

---

## Recently Completed Work (this session)

1. **RECURRENCE-ID fix for calendar-ticker** — the Edge Function was emitting moved recurring-event instances on both their original slot and new slot. Fixed with a two-pass approach: collect all VEVENTs first, build `overrideMap: uid → Set<original-ymd>` from VEVENTs with `RECURRENCE-ID`, then suppress those original dates during RRULE expansion. Deployed successfully.

2. **Follow-up drawer visual refinements** — dark floating inset drawer, warm monochrome card images, chip redesign (type-only: VIP/Collector/Gift/New), metadata line (follow-up action · piece count · $LTV), important dot badge, donechip button.

3. **Wix order webhook** — `wix-order` Edge Function live, idempotent via `processed_orders`, auto-upserts collectors on purchase.

4. **Instagram handle field + follower cross-reference** — 15 collectors matched from 1,682-follower Meta export.

5. **Bureau of Provenance tab** — editorial gallery, todos synced via `bureau_todos` Supabase table.

6. **Calendar ticker** — iCloud .ics proxy with full RRULE expansion (DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY/EXDATE + RECURRENCE-ID overrides).

---

## File Locations

| File | Path |
|---|---|
| Main app | `/Users/aco/Documents/git/macon-archive/index.html` |
| Schema | `/Users/aco/Documents/git/macon-archive/schema.sql` |
| calendar-ticker | `/Users/aco/Documents/git/macon-archive/supabase/functions/calendar-ticker/index.ts` |
| wix-order | `/Users/aco/Documents/git/macon-archive/supabase/functions/wix-order/index.ts` |
| followup-digest | `/Users/aco/Documents/git/macon-archive/supabase/functions/followup-digest/index.ts` |
| Wix webhook README | `/Users/aco/Documents/git/macon-archive/supabase/README-wix-webhook.md` |
| Follow-up README | `/Users/aco/Documents/git/macon-archive/supabase/README-followups.md` |

---

## Editing Guidelines

- **index.html is ~5000+ lines** — always use Python atomic read/replace/write or targeted Edit tool. Never rewrite the whole file.
- **After any JS edit**, validate with: `node --check /tmp/macon_main.js` (extract the script block first)
- **Commits** go as: `git add index.html && git commit -m "..." && git push` from the `macon-archive/` directory
- **Supabase CLI:** `~/.local/bin/supabase` — always use full path
- Deploy functions: `~/.local/bin/supabase functions deploy <name> --no-verify-jwt`

---

## Pending / Open Issues

1. **Red dot ring color** — `.fimp` box-shadow ring is `#26221d` but still reads as black. Likely needs `#3a3028` or lighter to visibly match the warm dark-brown rendered drawer surface.
2. No other known open issues.

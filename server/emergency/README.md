# Emergency response (SOS → hospital dispatch → live ambulance tracking)

A bystander at a crash taps **SOS**. Hospitals that can treat road-accident
victims are ranked by **drive time**; the best three are alerted, and the
first to **accept** owns the case. If nobody answers within 90 s the next
three are alerted (up to three rounds). The accepting hospital moves the case
through *dispatched → on scene → transporting → closed*, and the ambulance crew
can share live GPS, so the bystander watches it approach with an ETA.

## Pages

| Page | Who | What |
|---|---|---|
| `emergency.html` | anyone, no login | SOS: GPS/pin, one-tap triage, optional photo/note/phone, nearest hospitals, 108/112 always visible |
| `track.html?id=&t=` | the reporter (tracking token) | live status, map with ambulance + route, first aid, add details, cancel |
| `hospital.html` | public + hospital/admin accounts | directory with capability/ER status/"nearest by drive time"; responder console; admin tools |
| `crew.html?id=&t=` | ambulance driver (crew link) | navigate, share live location, update status |
| `coverage.html` | public | ambulance-desert map + SOS response-time (golden hour) metrics |
| `report.html` | signed-in users | "This is happening right now" also sends an SOS |

Every page except those three shows a floating **SOS** button (`js/sos-button.js`).

## Setup

1. **Schema** — `Database/emergency.sql` (idempotent). The API applies it on
   startup unless `EMERGENCY_AUTO_MIGRATE=false`; or run it with `psql`.
2. **Hospitals** — `npm run seed:hospitals` (from `server/`). Fetches OSM via
   Overpass (falls back to `data/osm-hospitals.raw.json` when Overpass is down;
   `--offline` forces that), classifies each facility, merges duplicates and
   prunes stale rows. Rows an admin verified, manual rows and hospitals linked
   to an account are never overwritten or pruned.
3. **Hospital accounts** — the staff member signs up normally; an admin opens
   `hospital.html`, and under *Admin → Link a hospital account* enters their
   email and picks the hospital. This sets `app_metadata.role = "hospital"` in
   Supabase and links the user in `hospital_users`. (Sign out/in to refresh.)
4. **Demo data** — `npm run simulate:emergencies` creates 60 *drill* alerts over
   30 days through the real dispatch logic, so `coverage.html` has response
   metrics to show (tick "Include drill alerts"). Remove them with
   `npm run simulate:emergencies -- --clear` or the admin button.

## How hospitals are classified (`hospitals.mjs`)

`emergency_level` is one of `trauma` (curated list of Bengaluru trauma/tertiary
centres), `emergency` (OSM `emergency=yes`, multispeciality, government,
medical college…), `general` (hospital, capability unknown) or `none` (dental,
eye, maternity, AYUSH, diagnostics, clinics, OPD/department entries…). Only the
first three receive alerts. Admins can correct any record (*Edit* on a card);
that sets `level_source = 'admin'`.

## Ranking (`service.mjs`)

Score = OSRM drive time (× time-of-day traffic factor) + a penalty by priority
and capability (critical patients: general hospitals +10 min, 24×7 emergency
+3; minor cases keep trauma centres free) + 8 min if the ER is **busy**.
**Diverting** ERs are skipped. Only one OSM entry per campus (250 m) is
alerted per round.

Priority comes from bystander triage (`triage.mjs`): not breathing,
unconscious, heavy bleeding, trapped, fire or 3+ injured → **critical**;
nothing known → **urgent**; nobody injured → **standard**. A scene photo can
raise it (free vision model), never lower it.

## Access & privacy

- The reporter's credential is the random tracking token in the link (only its
  SHA-256 is stored); crew links work the same way and are scoped to one case.
- Hospital endpoints verify the Supabase session with Supabase itself
  (`supabase.auth.getUser`), not just by decoding the JWT.
- Reporter phone numbers and notes go only to hospitals that were alerted or
  accepted. Scene photos are stored in Postgres (not a public bucket),
  re-encoded without EXIF, and served only to the reporter's alerted hospitals
  and admins.
- Duplicate reports of the same crash (≤ 200 m, ≤ 15 min) merge into one
  alert; SOS creation is rate-limited per IP.

## Configuration (`server/.env`)

| Variable | Default | |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | used in crew links and SMS/email alert links |
| `OSRM_URL` | public OSRM demo server | self-host for production |
| `EMERGENCY_TRAFFIC_FACTOR` | time-of-day table | force a constant multiplier |
| `EMERGENCY_DISABLE_OSRM` | `false` | straight-line estimates only |
| `EMERGENCY_AUTO_MIGRATE` | `true` | apply `Database/emergency.sql` on startup |
| `TWILIO_SID/TOKEN/FROM`, `SENDGRID_API_KEY`, `FROM_EMAIL` | — | optional SMS / email alerts to hospitals (`notify.mjs`) |

Real-time updates use Server-Sent Events from a single API process
(`bus.mjs`). Running several API instances would need Postgres
`LISTEN/NOTIFY` or Supabase Realtime instead.

## Tests

`npm run test:emergency` — classification, triage, metrics, dispatch service
(ranking, escalation, accept race, lifecycle, privacy) and HTTP routes, all
offline on the in-memory store.

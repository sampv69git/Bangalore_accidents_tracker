
## SAMARTH — Data, Analytics, Admin & Emergency Backend

### 1. Analytics & Trends

#### 1.1 Aggregation endpoints (`server/index.js`)
- [x] `GET /api/stats/trends` — accidents grouped by month with severity counts.
  - **Returns:** `[{ month: "2026-01", total, fatal, serious, minor }]`
  - **Detail:** Use a Supabase RPC for server-side `GROUP BY date_trunc('month', accident_date)`. Do **not** pull all rows to the client.
- [x] `GET /api/stats/by-time` — group by hour-of-day (0–23) and day-of-week (0–6).
  - **Returns:** `{ byHour: [...24], byDay: [...7] }`
  - **Detail:** Parse time from `date_raw`/`accident_date`; null-safe.
- [x] `GET /api/stats/by-area` — totals + severity breakdown per area and zone.
  - **Returns:** `[{ area, zone, total, fatal, serious, minor }]`

#### 1.2 Supabase RPC (`Database/schema.sql`)
- [x] Add `get_stats_monthly()`, `get_stats_by_time()`, `get_stats_by_area()` SQL functions.
- [x] Only count `status = 'active'` and non-null `geom` (match existing `/api/meta` behaviour).

#### 1.3 Trends page (frontend)
- [x] Create `Frontend/trends.html` (reuse nav/footer from `index.html`).
- [x] Add Chart.js via CDN; create `Frontend/js/trends-app.js`.
- [x] Build charts: accidents-over-time line, severity pie/doughnut, area bar chart, time-of-day heatmap.
- [x] Add a "Trends" link to the nav on `index.html`, `dashboard.html`, `report.html`, `profile.html`.
- **Acceptance:** Page loads real aggregated data, charts render, no client-side full-table pull.

### 2. Data Export & Public API
- [x] Add `?format=csv` to `GET /api/accidents` — convert GeoJSON features to CSV (id, date, severity, area, zone, lat, lng, location).
- [x] `GET /api/export/geojson` — current filters applied, downloadable.
- [x] Add `express-rate-limit` to public endpoints (e.g. 100 req / 15 min / IP).
- [x] Add "Download CSV / GeoJSON" buttons on dashboard + trends page.
- **Acceptance:** Downloaded CSV opens cleanly in Excel; rate limit returns HTTP 429 when exceeded.

### 3. Admin & Moderation

#### 3.1 Backend (`server/index.js`, reuse `adminAuth`)
- [x] `GET /api/admin/reports/pending` — filter `status = 'pending'` AND `reporter_id` not null (user submissions only).
- [x] Extend `PATCH /api/admin/accidents/:id` to accept `rejection_reason`; verifying sets `status = 'active'`, rejecting sets `status = 'hidden'`.
- [x] `POST /api/admin/accidents/bulk` — accept `{ ids: [], action: 'verify'|'hide'|'delete' }`.
- [x] Duplicate detection helper — flag records within ~100m (PostGIS `ST_DWithin`) and same `accident_date`.

#### 3.2 Database (`Database/schema.sql`)
- [x] Add `rejection_reason TEXT` column to `accidents`.

#### 3.3 Admin UI (`Frontend/admin.html` + `js/admin-app.js`)
- [x] Add a "Pending Reports" filter/tab to the records table.
- [x] Approve / Reject buttons with a reason-input modal.
- [x] Checkbox column + bulk-action toolbar.
- **Acceptance:** Admin can approve a user report and see it appear on the public map; reject stores a reason.

### 4. Emergency Backend & Hospital Side

#### 4.1 Database (`Database/schema.sql`)
- [x] `hospitals` table: `id, name, location geography(Point,4326), phone, address, created_at`.
- [x] `emergency_alerts` table: `id, photo_url, lat, lng, address, severity, description, status, notified_hospital_ids TEXT[], created_at`.
- [x] Spatial index: `CREATE INDEX ON hospitals USING GIST (location);`

#### 4.2 Hospital seeding (`server/seed-hospitals.mjs`)
- [x] Source Bangalore hospital data from OpenStreetMap (Overpass API) or a CSV dataset.
- [x] Insert name, phone (if available), address, and `POINT(lng lat)` geography.
- [x] Add `"seed:hospitals": "node seed-hospitals.mjs"` to `server/package.json` scripts.

#### 4.3 Backend endpoints (`server/index.js`)
- [x] `GET /api/hospitals/near?lat=&lng=&limit=5` — PostGIS nearest-neighbor using the `<->` operator; return `[{ id, name, phone, address, distance_km }]` ordered by distance.
- [x] `POST /api/emergency` — accept `{ photo_url, lat, lng }`:
  1. Reverse-geocode to an address (reuse Nominatim helper).
  2. Call the vision LLM for `{ severity, description }`.
  3. Query nearest hospitals.
  4. Insert into `emergency_alerts` with `notified_hospital_ids`.
  5. Return `{ alertId, hospitals: [...], severity, description }`.
- [x] Vision LLM function — extend OpenRouter usage with a **multimodal** model; input image URL, output estimated severity + short description. Default gracefully to `minor` + generic text on failure.

#### 4.4 Hospital role & dashboard
- [x] Add a `hospital` role check middleware (mirror `requireAdmin`, read `app_metadata.role`).
- [x] `GET /api/hospital/alerts` — list recent alerts (role-gated).
- [x] Create `Frontend/hospital.html` + `js/hospital-app.js` — served via secret slug (like admin) or role-gated.
- [x] Dashboard lists incoming alerts: photo, mini-map of location, **estimated** severity, timestamp, distance; polls for new alerts.
- **Acceptance:** Submitting an emergency creates an alert that appears on the hospital dashboard within the poll interval.


<a name="shivkumar"></a>
## SHIVKUMAR — Citizen Experience, Maps & Emergency Frontend

### 1. Fix & Complete Reporting

#### 1.1 Supabase Storage + backend (`server/index.js`)
- [ ] Create a Supabase Storage bucket (e.g. `proof-images`) with appropriate access policy.
- [ ] Extend `POST /api/reports` to accept and persist `photo_url`.
- [ ] Add `PATCH /api/reports/mine/:id` and `DELETE /api/reports/mine/:id` — only the owning `reporter_id` and only while `status = 'pending'`.
- [ ] Add `express-rate-limit` to `/api/reports` (anti-spam, e.g. 10 / hour / user).

#### 1.2 Database (`Database/schema.sql`)
- [ ] Add `photo_url TEXT` column to `accidents`.

#### 1.3 Report page (`Frontend/report.html`)
- [ ] Wire the existing upload UI (currently preview-only) to actually upload to Supabase Storage and send `photo_url` in the report payload.
- [ ] Reverse-geocode on pin drop — auto-fill `#field-area` / `#field-location` from coordinates via Nominatim reverse endpoint.
- [ ] Show upload progress and error states; block submit until upload completes.
- **Acceptance:** A submitted report stores its photo; the photo URL is retrievable via `/api/reports/mine`.

### 2. Map & Dashboard Enhancements (`Frontend/dashboard.html` + `js/dashboard-app.js`)
- [ ] MapLibre marker clustering for dense areas; expand clusters on zoom.
- [ ] Deep-linkable filters — read and write `?area=&severity=&from=&to=` in the URL; apply on page load.
- [ ] Enhance the slide-in detail panel to show the proof image when present.
- [ ] "Share this view" button that copies the current filtered URL to clipboard.
- **Acceptance:** A shared URL reproduces the exact filtered map state on load.

### 3. Profile & Notifications (`Frontend/profile.html`)
- [ ] Plot the user's reported pins on the currently-empty `#profile-mini-map` (Leaflet markers).
- [ ] Add edit/delete controls for pending reports (call the new `/api/reports/mine/:id` endpoints).
- [ ] Contribution badges (e.g. "Bronze: 1 report", "Silver: 5 verified", "Gold: 10 verified").
- [ ] In-app notification banner when a report's status changes (poll `/api/reports/mine`, compare against last-seen state in `localStorage`).
- [ ] *(Stretch)* Email on verify/reject via Supabase.
- **Acceptance:** Mini-map shows the user's pins; status change surfaces a banner.

### 4. Platform & Accessibility
- [ ] PWA — add `Frontend/manifest.json` + a service worker; make the app installable and cache the shell.
- [ ] Kannada / Hindi language toggle — string dictionary + `localStorage` preference, applied across pages.
- [ ] Accessibility pass — ARIA labels on interactive controls, keyboard navigation, severity color-contrast check (WCAG AA).
  - **Note:** Full WCAG compliance needs manual testing with assistive tech; document what was validated.

### 5. Emergency SOS Frontend (`Frontend/emergency.html` + `js/emergency-app.js`)
- [x] Prominent **SOS / Emergency** button on `dashboard.html` and `index.html` that opens the emergency flow. *(floating SOS button on every page — `js/sos-button.js`)*
- [x] Full-screen capture page: camera input (`capture="environment"`) + photo preview + retake.
- [x] Capture GPS via `navigator.geolocation`; show accuracy, allow retry, handle permission denial. *(plus draggable pin / tap-to-place)*
- [x] ~~Upload photo to Supabase Storage, then `POST /api/emergency`~~ → the SOS is sent first (no waiting on uploads), then the photo goes to `POST /api/emergency/:id/photo` and is stored privately (victims may be identifiable). The old `{ photo_url, lat, lng }` contract still works.
- [x] Confirmation screen — nearest hospitals with distance, tap-to-call (`tel:`), tap-to-navigate (maps deep link). *(→ `track.html`: live status, ambulance on map, ETA, first aid)*
- [x] Prominent **Call 108 (ambulance) / 112** quick-dial buttons, always visible.
- [x] Disclaimer: "This supplements, and does not replace, emergency services." Label AI severity as **estimated**.
- [x] Robust failure handling — if network drops mid-flow, immediately surface the 108/112 call buttons as fallback.
- **Acceptance:** Full flow works on a phone; if the API fails, emergency call buttons are still one tap away.

### 5b. Emergency response v2 (done — see `server/emergency/README.md`)
- [x] Hospital IDs no longer collide (1,155 → 1,370 distinct OSM hospitals); facilities classified as trauma / emergency / general / none.
- [x] Hospital accounts linked to their hospital (`hospital_users`), sessions verified with Supabase.
- [x] Dispatch lifecycle new → accepted → dispatched → on scene → transporting → closed; first hospital to accept wins; 90 s escalation rounds.
- [x] Drive-time ranking (OSRM), ER status (accepting / busy / diverting), live ambulance GPS + crew links, real-time updates (SSE) with sound/notifications.
- [x] Bystander triage → priority, first-aid guidance, duplicate-report merging, rate limits.
- [x] `coverage.html`: ambulance-desert map + golden-hour response metrics; `npm run simulate:emergencies` for drill data.

### 6. Tests (`Frontend/js/__tests__/`)
- [ ] `url-filters.test.js` — filter parse/serialize round-trip.
- [ ] `report-edit.test.js` — edit/delete own pending report flows.
- [ ] `emergency.test.js` — payload construction + geolocation handling (mock `navigator.geolocation`).

---

<a name="shared"></a>
## Shared / Coordination Tasks
- [ ] **Define API contracts together** before parallel work — see below.
- [ ] **Supabase Storage** — Shivkumar sets up the bucket in Phase 1; Samarth reuses it for emergency photos in Phase 3.
- [ ] **`schema.sql` changes** — both edit it; use separated, labelled sections and review each other's migrations.
- [ ] **Roles** — align on how `admin` and `hospital` roles are stored in the Supabase JWT (`app_metadata.role`).
- [ ] **CORS** — ensure new pages/origins are covered by `CORS_ORIGIN` in `server/.env`.

---

<a name="phasing"></a>
## Phasing Plan

| Phase | Samarth | Shivkumar |
|-------|---------|-----------|
| **1 — Foundation** | Trends page + `/api/stats/trends` + RPCs | Supabase Storage + proof upload working |
| **2 — Moderation & UX** | Pending-reports queue + approve/reject + bulk | Map clustering + shareable filters |
| **3 — Emergency** | Hospitals table + `/api/hospitals/near` + `/api/emergency` + vision LLM | SOS capture page + GPS + confirmation screen |
| **4 — Polish** | Hospital alert dashboard + CSV/API export | Status notifications + PWA + i18n + a11y |

**Why this order:** Emergency (Phase 3) reuses the Supabase Storage foundation from Phase 1 (Shivkumar) and benefits from moderation patterns built in Phase 2 (Samarth).

---

<a name="api-contracts"></a>
## API Contracts (agree first)

### `POST /api/reports` (extended)
```json
// request
{ "latitude": 12.97, "longitude": 77.59, "location": "...", "area": "...",
  "severity": "minor", "date": "2026-06-23", "time": "14:30",
  "description": "...", "photo_url": "https://.../proof.jpg" }
// response 201
{ "id": "1234" }
```

### `GET /api/hospitals/near?lat=&lng=&limit=5`
```json
[ { "id": 1, "name": "Victoria Hospital", "phone": "080...",
    "address": "...", "distance_km": 1.4 } ]
```

### `POST /api/emergency`
```json
// request
{ "photo_url": "https://.../scene.jpg", "lat": 12.97, "lng": 77.59 }
// response 201
{ "alertId": "alert_...", "severity": "serious", "description": "estimated: ...",
  "hospitals": [ { "id": 1, "name": "...", "phone": "...", "distance_km": 1.4 } ] }
```

### `GET /api/stats/trends`
```json
[ { "month": "2026-01", "total": 42, "fatal": 5, "serious": 18, "minor": 19 } ]
```

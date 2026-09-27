/**
 * In-memory emergency store. Same interface as store-pg.mjs; used by the
 * tests and as a fallback when no database is configured (data is lost on
 * restart). Hospitals come from seed-hospitals.json.
 */
import { haversineKm } from '../ai/geo.mjs';
import { DISPATCHABLE_LEVELS } from './hospitals.mjs';

const OPEN = new Set(['new', 'accepted', 'dispatched', 'on_scene', 'transporting']);
const clone = (x) => (x == null ? x : structuredClone(x));

function hospitalRow(h) {
  return {
    id: h.id, name: h.name, phone: h.phone ?? null, email: h.email ?? null, webhook_url: h.webhook_url ?? null,
    address: h.address ?? null, lat: h.lat ?? null, lng: h.lng ?? null,
    facility_type: h.facility_type ?? 'hospital', emergency_level: h.emergency_level ?? 'general',
    level_source: h.level_source ?? null, beds: h.beds ?? null, operator_type: h.operator_type ?? null,
    verified: !!h.verified, er_status: h.er_status ?? null, er_status_note: h.er_status_note ?? null,
    er_status_updated_at: h.er_status_updated_at ?? null,
  };
}

function matches(row, expect = {}) {
  return Object.entries(expect).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
}

export function createMemoryStore({ hospitals = [], now = () => new Date() } = {}) {
  const H = new Map(hospitals.filter(h => h && h.id).map(h => [h.id, hospitalRow(h)]));
  const users = new Map();
  const alerts = new Map();
  const targets = new Map(); // alertId -> Map(hospitalId -> row)
  const events = [];
  const photos = [];
  let seq = 0;

  const dist = (h, lat, lng) => haversineKm(lat, lng, h.lat, h.lng);

  return {
    kind: 'memory',
    async ready() {},

    // ── Hospitals ──────────────────────────────────────────────────────────
    async nearestHospitals({ lat, lng, limit = 10, levels = null, excludeIds = [] }) {
      const ex = new Set(excludeIds);
      return [...H.values()]
        .filter(h => h.lat != null && !ex.has(h.id) && (!levels || levels.includes(h.emergency_level)))
        .map(h => ({ ...h, distance_km: dist(h, lat, lng) }))
        .sort((a, b) => a.distance_km - b.distance_km)
        .slice(0, limit)
        .map(clone);
    },
    async getHospital(id) { return clone(H.get(id) || null); },
    async getHospitals(ids) { return ids.map(id => H.get(id)).filter(Boolean).map(clone); },
    async searchHospitals({ q = '', level = null, offset = 0, limit = 60 }) {
      const s = q.toLowerCase();
      const levels = level === 'dispatchable' ? DISPATCHABLE_LEVELS : level ? [level] : null;
      const all = [...H.values()]
        .filter(h => !levels || levels.includes(h.emergency_level))
        .filter(h => !s || [h.name, h.address, h.phone].some(v => v && v.toLowerCase().includes(s)))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { total: all.length, hospitals: all.slice(offset, offset + limit).map(clone) };
    },
    async hospitalStats() {
      const byLevel = {}, byErStatus = {};
      for (const h of H.values()) {
        byLevel[h.emergency_level] = (byLevel[h.emergency_level] || 0) + 1;
        if (h.er_status) byErStatus[h.er_status] = (byErStatus[h.er_status] || 0) + 1;
      }
      return { total: H.size, byLevel, byErStatus };
    },
    async listDispatchableHospitals() {
      return [...H.values()].filter(h => h.lat != null && DISPATCHABLE_LEVELS.includes(h.emergency_level)).map(clone);
    },
    async updateHospital(id, patch) {
      const h = H.get(id);
      if (!h) return null;
      Object.assign(h, patch);
      return clone(h);
    },

    // ── Hospital accounts ──────────────────────────────────────────────────
    async getHospitalUser(userId) {
      const u = users.get(String(userId));
      return u ? { ...clone(u), hospital: clone(H.get(u.hospital_id) || null) } : null;
    },
    async linkHospitalUser({ userId, hospitalId, email = null, createdBy = null }) {
      const row = { user_id: String(userId), hospital_id: hospitalId, email, created_by: createdBy, created_at: now() };
      users.set(row.user_id, row);
      return clone(row);
    },
    async unlinkHospitalUser(userId) { return users.delete(String(userId)); },
    async listHospitalUsers() {
      return [...users.values()].map(u => ({ ...clone(u), hospital_name: H.get(u.hospital_id)?.name || null }));
    },

    // ── Alerts ─────────────────────────────────────────────────────────────
    async insertAlert(alert) {
      const row = { notified_hospital_ids: [], track_token_hashes: [], crew_token_hashes: [], photo_count: 0, report_count: 1, escalation_round: 0, is_drill: false, created_at: now(), updated_at: now(), ...clone(alert) };
      alerts.set(row.id, row);
      return clone(row);
    },
    async getAlert(id) { return clone(alerts.get(id) || null); },
    async updateAlert(id, patch, { expect } = {}) {
      const a = alerts.get(id);
      if (!a || (expect && !matches(a, expect))) return null;
      Object.assign(a, clone(patch), { updated_at: now() });
      return clone(a);
    },
    async addTokenHash(id, column, hash) {
      const a = alerts.get(id);
      if (!a) return null;
      a[column] = [...(a[column] || []), hash];
      return clone(a);
    },
    async findOpenAlertNear({ lat, lng, radiusM, since, isDrill = false }) {
      let best = null;
      for (const a of alerts.values()) {
        if (!OPEN.has(a.status) || a.created_at < since || !!a.is_drill !== !!isDrill) continue;
        const d = haversineKm(lat, lng, a.lat, a.lng) * 1000;
        if (d <= radiusM && (!best || d < best.d)) best = { a, d };
      }
      return best ? clone(best.a) : null;
    },
    async listAlerts({ since, hospitalId = null, center = null, radiusKm = 15, limit = 100 }) {
      return [...alerts.values()]
        .filter(a => a.created_at >= since)
        .filter(a => !hospitalId
          || a.accepted_hospital_id === hospitalId
          || targets.get(a.id)?.has(hospitalId)
          || (a.status === 'new' && center && haversineKm(center.lat, center.lng, a.lat, a.lng) <= radiusKm))
        .sort((x, y) => y.created_at - x.created_at)
        .slice(0, limit)
        .map(clone);
    },
    async dueForEscalation(at) {
      return [...alerts.values()]
        .filter(a => a.status === 'new' && a.next_escalation_at && a.next_escalation_at <= at && !a.escalation_exhausted_at)
        .map(clone);
    },
    async alertsForMetrics({ since, includeDrills = false }) {
      return [...alerts.values()].filter(a => a.created_at >= since && (includeDrills || !a.is_drill)).map(clone);
    },
    async deleteDrills() {
      let n = 0;
      for (const [id, a] of alerts) if (a.is_drill) { alerts.delete(id); targets.delete(id); n++; }
      return n;
    },

    // ── Targets (hospitals offered an alert) ───────────────────────────────
    async addTargets(alertId, rows) {
      if (!targets.has(alertId)) targets.set(alertId, new Map());
      const m = targets.get(alertId);
      for (const r of rows) if (!m.has(r.hospital_id)) m.set(r.hospital_id, { response: 'pending', notified_at: now(), responded_at: null, decline_reason: null, notify_result: null, ...clone(r), alert_id: alertId });
      const a = alerts.get(alertId);
      if (a) a.notified_hospital_ids = [...new Set([...(a.notified_hospital_ids || []), ...rows.map(r => r.hospital_id)])];
    },
    async upsertTarget(alertId, hospitalId, patch) {
      if (!targets.has(alertId)) targets.set(alertId, new Map());
      const m = targets.get(alertId);
      const cur = m.get(hospitalId) || { alert_id: alertId, hospital_id: hospitalId, round: 0, response: 'pending', notified_at: now() };
      m.set(hospitalId, { ...cur, ...clone(patch) });
      return clone(m.get(hospitalId));
    },
    async markPendingTargets(alertId, response, exceptHospitalId = null) {
      for (const t of targets.get(alertId)?.values() || []) {
        if (t.response === 'pending' && t.hospital_id !== exceptHospitalId) { t.response = response; t.responded_at = now(); }
      }
    },
    async getTargets(alertId) {
      return [...(targets.get(alertId)?.values() || [])].sort((a, b) => a.round - b.round || (a.eta_min ?? 1e9) - (b.eta_min ?? 1e9)).map(clone);
    },
    async getTargetsForAlerts(alertIds) {
      const out = new Map();
      for (const id of alertIds) out.set(id, [...(targets.get(id)?.values() || [])].map(clone));
      return out;
    },

    // ── Events & photos ────────────────────────────────────────────────────
    async addEvent({ alert_id, type, actor = null, hospital_id = null, data = {} }) {
      const row = { id: ++seq, alert_id, type, actor, hospital_id, data: clone(data), created_at: now() };
      events.push(row);
      return clone(row);
    },
    async getEvents(alertId) { return events.filter(e => e.alert_id === alertId).map(clone); },
    async addPhoto(alertId, mime, bytes) {
      const row = { id: ++seq, alert_id: alertId, mime, bytes: Buffer.from(bytes), created_at: now() };
      photos.push(row);
      const a = alerts.get(alertId);
      if (a) a.photo_count = (a.photo_count || 0) + 1;
      return { id: row.id };
    },
    async getPhoto(alertId, index = null) {
      const list = photos.filter(p => p.alert_id === alertId);
      const p = index == null ? list[list.length - 1] : list[index];
      return p ? { mime: p.mime, bytes: p.bytes } : null;
    },
  };
}

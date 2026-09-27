/**
 * PostgreSQL + PostGIS emergency store (tables from Database/emergency.sql).
 * Same interface as store-memory.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DISPATCHABLE_LEVELS } from './hospitals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATION_PATH = path.join(__dirname, '..', '..', 'Database', 'emergency.sql');

const HOSPITAL_COLS = `id, name, phone, email, webhook_url, address,
  ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
  facility_type, COALESCE(emergency_level, 'general') AS emergency_level, level_source, beds, operator_type,
  verified, er_status, er_status_note, er_status_updated_at`;

// Writable alert columns and how to cast their parameters.
const ALERT_COLUMNS = {
  id: 'text', photo_url: 'text', lat: 'float8', lng: 'float8', address: 'text', severity: 'text', description: 'text',
  status: 'text', notified_hospital_ids: 'text[]', priority: 'text', source: 'text', report_id: 'text', reporter_id: 'text',
  reporter_phone: 'text', accuracy_m: 'float8', triage: 'jsonb', note: 'text', vision_severity: 'text',
  vision_description: 'text', photo_count: 'int', track_token_hashes: 'text[]', crew_token_hashes: 'text[]',
  report_count: 'int', accepted_hospital_id: 'text', accepted_hospital_name: 'text', accepted_by: 'text',
  accepted_at: 'timestamptz', dispatched_at: 'timestamptz', on_scene_at: 'timestamptz', transporting_at: 'timestamptz',
  closed_at: 'timestamptz', cancelled_at: 'timestamptz', cancel_reason: 'text', close_outcome: 'text',
  escalation_round: 'int', next_escalation_at: 'timestamptz', escalation_exhausted_at: 'timestamptz',
  ambulance_lat: 'float8', ambulance_lng: 'float8', ambulance_accuracy_m: 'float8', ambulance_updated_at: 'timestamptz',
  ambulance_eta_min: 'float8', ambulance_eta_source: 'text', zone: 'text', is_drill: 'boolean', created_at: 'timestamptz',
};

const HOSPITAL_WRITABLE = {
  name: 'text', phone: 'text', email: 'text', webhook_url: 'text', address: 'text', facility_type: 'text',
  emergency_level: 'text', level_source: 'text', verified: 'boolean', er_status: 'text', er_status_note: 'text',
  er_status_updated_at: 'timestamptz', er_status_updated_by: 'text',
};

const TARGET_COLUMNS = {
  hospital_name: 'text', round: 'int', distance_km: 'float8', eta_min: 'float8', eta_source: 'text', rank_score: 'float8',
  response: 'text', decline_reason: 'text', notified_at: 'timestamptz', responded_at: 'timestamptz', notify_result: 'jsonb',
};

const param = (type, v) => (type === 'jsonb' && v != null ? JSON.stringify(v) : v);

/** Build "col = $n::type" assignments for whitelisted keys of `patch`. */
function assignments(patch, columns, params) {
  return Object.entries(patch).filter(([k]) => columns[k]).map(([k, v]) => {
    params.push(param(columns[k], v));
    return `${k} = $${params.length}::${columns[k]}`;
  });
}

function expectClause(expect, params) {
  return Object.entries(expect || {}).filter(([k]) => ALERT_COLUMNS[k]).map(([k, v]) => {
    if (Array.isArray(v)) { params.push(v); return `${k} = ANY($${params.length}::${ALERT_COLUMNS[k]}[])`; }
    params.push(v);
    return `${k} = $${params.length}::${ALERT_COLUMNS[k]}`;
  });
}

const point = (latIdx, lngIdx) => `ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography`;
const alertPoint = `ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography`;

export function createPgStore({ pool, logger = console, migrationPath = MIGRATION_PATH, autoMigrate = process.env.EMERGENCY_AUTO_MIGRATE !== 'false' }) {
  const q = async (text, params = []) => (await pool.query(text, params)).rows;

  return {
    kind: 'postgres',

    async ready() {
      if (!autoMigrate) return;
      try {
        await pool.query(fs.readFileSync(migrationPath, 'utf8'));
      } catch (e) {
        logger.warn?.('[emergency] schema migration failed (run Database/emergency.sql manually):', e.message);
      }
    },

    // ── Hospitals ──────────────────────────────────────────────────────────
    async nearestHospitals({ lat, lng, limit = 10, levels = null, excludeIds = [] }) {
      return q(
        `SELECT ${HOSPITAL_COLS}, ST_Distance(location, ${point(1, 2)}) / 1000 AS distance_km
         FROM hospitals
         WHERE location IS NOT NULL
           AND ($3::text[] IS NULL OR COALESCE(emergency_level, 'general') = ANY($3::text[]))
           AND NOT (id = ANY($4::text[]))
         ORDER BY location <-> ${point(1, 2)}
         LIMIT $5`,
        [lat, lng, levels, excludeIds, limit]
      );
    },
    async getHospital(id) { return (await q(`SELECT ${HOSPITAL_COLS} FROM hospitals WHERE id = $1`, [id]))[0] || null; },
    async getHospitals(ids) { return ids.length ? q(`SELECT ${HOSPITAL_COLS} FROM hospitals WHERE id = ANY($1::text[])`, [ids]) : []; },
    async searchHospitals({ q: search = '', level = null, offset = 0, limit = 60 }) {
      const levels = level === 'dispatchable' ? DISPATCHABLE_LEVELS : level ? [level] : null;
      const params = [search ? `%${search}%` : null, levels];
      const where = `WHERE ($1::text IS NULL OR name ILIKE $1 OR address ILIKE $1 OR phone ILIKE $1)
                       AND ($2::text[] IS NULL OR COALESCE(emergency_level, 'general') = ANY($2::text[]))`;
      const [rows, count] = await Promise.all([
        q(`SELECT ${HOSPITAL_COLS} FROM hospitals ${where} ORDER BY name LIMIT $3 OFFSET $4`, [...params, limit, offset]),
        q(`SELECT count(*)::int AS total FROM hospitals ${where}`, params),
      ]);
      return { total: count[0]?.total ?? 0, hospitals: rows };
    },
    async hospitalStats() {
      const rows = await q(`SELECT COALESCE(emergency_level, 'general') AS level, er_status, count(*)::int AS n FROM hospitals GROUP BY 1, 2`);
      const byLevel = {}, byErStatus = {};
      let total = 0;
      for (const r of rows) {
        total += r.n;
        byLevel[r.level] = (byLevel[r.level] || 0) + r.n;
        if (r.er_status) byErStatus[r.er_status] = (byErStatus[r.er_status] || 0) + r.n;
      }
      return { total, byLevel, byErStatus };
    },
    async listDispatchableHospitals() {
      return q(`SELECT ${HOSPITAL_COLS} FROM hospitals WHERE location IS NOT NULL AND COALESCE(emergency_level, 'general') = ANY($1::text[])`, [DISPATCHABLE_LEVELS]);
    },
    async updateHospital(id, patch) {
      const params = [id];
      const sets = assignments(patch, HOSPITAL_WRITABLE, params);
      if (!sets.length) return this.getHospital(id);
      const rows = await q(`UPDATE hospitals SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, params);
      return rows.length ? this.getHospital(id) : null;
    },

    // ── Hospital accounts ──────────────────────────────────────────────────
    async getHospitalUser(userId) {
      const u = (await q(`SELECT * FROM hospital_users WHERE user_id = $1`, [String(userId)]))[0];
      return u ? { ...u, hospital: await this.getHospital(u.hospital_id) } : null;
    },
    async linkHospitalUser({ userId, hospitalId, email = null, createdBy = null }) {
      return (await q(
        `INSERT INTO hospital_users (user_id, hospital_id, email, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET hospital_id = EXCLUDED.hospital_id, email = EXCLUDED.email, created_by = EXCLUDED.created_by, created_at = now()
         RETURNING *`,
        [String(userId), hospitalId, email, createdBy]
      ))[0];
    },
    async unlinkHospitalUser(userId) {
      return (await pool.query(`DELETE FROM hospital_users WHERE user_id = $1`, [String(userId)])).rowCount > 0;
    },
    async listHospitalUsers() {
      return q(`SELECT u.*, h.name AS hospital_name FROM hospital_users u LEFT JOIN hospitals h ON h.id = u.hospital_id ORDER BY u.created_at DESC`);
    },

    // ── Alerts ─────────────────────────────────────────────────────────────
    async insertAlert(alert) {
      const cols = Object.keys(alert).filter(k => ALERT_COLUMNS[k] && alert[k] !== undefined);
      const params = cols.map(k => param(ALERT_COLUMNS[k], alert[k]));
      const rows = await q(
        `INSERT INTO emergency_alerts (${cols.join(', ')}) VALUES (${cols.map((k, i) => `$${i + 1}::${ALERT_COLUMNS[k]}`).join(', ')}) RETURNING *`,
        params
      );
      return rows[0];
    },
    async getAlert(id) { return (await q(`SELECT * FROM emergency_alerts WHERE id = $1`, [id]))[0] || null; },
    async updateAlert(id, patch, { expect } = {}) {
      const params = [id];
      const sets = assignments(patch, ALERT_COLUMNS, params);
      const conds = expectClause(expect, params);
      const rows = await q(
        `UPDATE emergency_alerts SET ${[...sets, 'updated_at = now()'].join(', ')}
         WHERE id = $1 ${conds.map(c => `AND ${c}`).join(' ')} RETURNING *`,
        params
      );
      return rows[0] || null;
    },
    async addTokenHash(id, column, hash) {
      if (!['track_token_hashes', 'crew_token_hashes'].includes(column)) throw new Error('bad token column');
      return (await q(`UPDATE emergency_alerts SET ${column} = array_append(COALESCE(${column}, ARRAY[]::text[]), $2), updated_at = now() WHERE id = $1 RETURNING *`, [id, hash]))[0] || null;
    },
    async findOpenAlertNear({ lat, lng, radiusM, since, isDrill = false }) {
      return (await q(
        `SELECT a.* FROM emergency_alerts a
         WHERE a.status IN ('new', 'accepted', 'dispatched', 'on_scene', 'transporting')
           AND a.created_at >= $3 AND a.is_drill = $5
           AND ST_DWithin(${alertPoint}, ${point(1, 2)}, $4)
         ORDER BY ST_Distance(${alertPoint}, ${point(1, 2)}) LIMIT 1`,
        [lat, lng, since, radiusM, !!isDrill]
      ))[0] || null;
    },
    async listAlerts({ since, hospitalId = null, center = null, radiusKm = 15, limit = 100 }) {
      return q(
        `SELECT a.* FROM emergency_alerts a
         WHERE a.created_at >= $1
           AND ($2::text IS NULL
                OR a.accepted_hospital_id = $2
                OR EXISTS (SELECT 1 FROM emergency_alert_targets t WHERE t.alert_id = a.id AND t.hospital_id = $2)
                OR (a.status = 'new' AND $3::float8 IS NOT NULL
                    AND ST_DWithin(${alertPoint}, ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326)::geography, $5 * 1000)))
         ORDER BY a.created_at DESC LIMIT $6`,
        [since, hospitalId, center?.lat ?? null, center?.lng ?? null, radiusKm, limit]
      );
    },
    async dueForEscalation(at) {
      return q(`SELECT * FROM emergency_alerts WHERE status = 'new' AND next_escalation_at <= $1 AND escalation_exhausted_at IS NULL`, [at]);
    },
    async alertsForMetrics({ since, includeDrills = false }) {
      return q(
        `SELECT id, status, priority, severity, lat, lng, zone, source, is_drill, report_count, escalation_round,
                escalation_exhausted_at, accepted_hospital_id, accepted_hospital_name, created_at, accepted_at,
                dispatched_at, on_scene_at, transporting_at, closed_at, cancelled_at, close_outcome
         FROM emergency_alerts WHERE created_at >= $1 AND ($2::boolean OR NOT is_drill)`,
        [since, includeDrills]
      );
    },
    async deleteDrills() {
      return (await pool.query(`DELETE FROM emergency_alerts WHERE is_drill`)).rowCount;
    },

    // ── Targets ────────────────────────────────────────────────────────────
    async addTargets(alertId, rows) {
      if (!rows.length) return;
      await q(
        `INSERT INTO emergency_alert_targets (alert_id, hospital_id, hospital_name, round, distance_km, eta_min, eta_source, rank_score)
         SELECT $1, r.hospital_id, r.hospital_name, r.round, r.distance_km, r.eta_min, r.eta_source, r.rank_score
         FROM jsonb_to_recordset($2::jsonb) AS r(hospital_id text, hospital_name text, round int, distance_km float8, eta_min float8, eta_source text, rank_score float8)
         ON CONFLICT (alert_id, hospital_id) DO NOTHING`,
        [alertId, JSON.stringify(rows)]
      );
      await q(
        `UPDATE emergency_alerts SET notified_hospital_ids = ARRAY(SELECT DISTINCT unnest(COALESCE(notified_hospital_ids, ARRAY[]::text[]) || $2::text[]))
         WHERE id = $1`,
        [alertId, rows.map(r => r.hospital_id)]
      );
    },
    async upsertTarget(alertId, hospitalId, patch) {
      const params = [alertId, hospitalId];
      const sets = assignments(patch, TARGET_COLUMNS, params);
      const cols = Object.keys(patch).filter(k => TARGET_COLUMNS[k]);
      const insertCols = ['alert_id', 'hospital_id', ...cols];
      const hasRound = cols.includes('round');
      return (await q(
        `INSERT INTO emergency_alert_targets (${insertCols.join(', ')}${hasRound ? '' : ', round'})
         VALUES ($1, $2${cols.map((k, i) => `, $${i + 3}::${TARGET_COLUMNS[k]}`).join('')}${hasRound ? '' : ', 0'})
         ON CONFLICT (alert_id, hospital_id) DO UPDATE SET ${sets.length ? sets.join(', ') : 'round = emergency_alert_targets.round'}
         RETURNING *`,
        params
      ))[0];
    },
    async markPendingTargets(alertId, response, exceptHospitalId = null) {
      await q(
        `UPDATE emergency_alert_targets SET response = $2, responded_at = now()
         WHERE alert_id = $1 AND response = 'pending' AND ($3::text IS NULL OR hospital_id <> $3)`,
        [alertId, response, exceptHospitalId]
      );
    },
    async getTargets(alertId) {
      return q(`SELECT * FROM emergency_alert_targets WHERE alert_id = $1 ORDER BY round, eta_min NULLS LAST`, [alertId]);
    },
    async getTargetsForAlerts(alertIds) {
      const out = new Map(alertIds.map(id => [id, []]));
      if (!alertIds.length) return out;
      for (const t of await q(`SELECT * FROM emergency_alert_targets WHERE alert_id = ANY($1::text[])`, [alertIds])) out.get(t.alert_id)?.push(t);
      return out;
    },

    // ── Events & photos ────────────────────────────────────────────────────
    async addEvent({ alert_id, type, actor = null, hospital_id = null, data = {} }) {
      return (await q(
        `INSERT INTO emergency_alert_events (alert_id, type, actor, hospital_id, data) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [alert_id, type, actor, hospital_id, JSON.stringify(data || {})]
      ))[0];
    },
    async getEvents(alertId) {
      return q(`SELECT * FROM emergency_alert_events WHERE alert_id = $1 ORDER BY created_at, id`, [alertId]);
    },
    async addPhoto(alertId, mime, bytes) {
      const row = (await q(`INSERT INTO emergency_alert_photos (alert_id, mime, bytes) VALUES ($1, $2, $3) RETURNING id`, [alertId, mime, bytes]))[0];
      await q(`UPDATE emergency_alerts SET photo_count = COALESCE(photo_count, 0) + 1 WHERE id = $1`, [alertId]);
      return row;
    },
    async getPhoto(alertId, index = null) {
      const rows = index == null
        ? await q(`SELECT mime, bytes FROM emergency_alert_photos WHERE alert_id = $1 ORDER BY id DESC LIMIT 1`, [alertId])
        : await q(`SELECT mime, bytes FROM emergency_alert_photos WHERE alert_id = $1 ORDER BY id OFFSET $2 LIMIT 1`, [alertId, index]);
      return rows[0] || null;
    },
  };
}

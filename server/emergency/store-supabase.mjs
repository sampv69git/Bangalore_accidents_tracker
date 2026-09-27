/**
 * Supabase (REST) emergency store — used when there is no direct Postgres
 * connection (no DATABASE_URL) but SUPABASE_URL + service-role key are set.
 *
 * Same interface as store-memory.mjs / store-pg.mjs. The in-memory store is
 * the working set (dispatch reads stay fast and synchronous-ish); every change
 * is written through to the Supabase tables from Database/emergency.sql, and
 * the working set is reloaded from them on startup, so alerts, hospital
 * accounts and ER status survive restarts. Writes are applied in order on a
 * single queue; a failed write is logged, never surfaced to the reporter.
 *
 * Needs the service-role key: these tables have RLS on and no public policies.
 */
import { createMemoryStore } from './store-memory.mjs';

const ALERT_COLUMNS = [
  'id', 'photo_url', 'lat', 'lng', 'address', 'severity', 'description', 'status', 'notified_hospital_ids', 'priority',
  'source', 'report_id', 'reporter_id', 'reporter_phone', 'accuracy_m', 'triage', 'note', 'vision_severity',
  'vision_description', 'photo_count', 'track_token_hashes', 'crew_token_hashes', 'report_count', 'accepted_hospital_id',
  'accepted_hospital_name', 'accepted_by', 'accepted_at', 'dispatched_at', 'on_scene_at', 'transporting_at', 'closed_at',
  'cancelled_at', 'cancel_reason', 'close_outcome', 'escalation_round', 'next_escalation_at', 'escalation_exhausted_at',
  'ambulance_lat', 'ambulance_lng', 'ambulance_accuracy_m', 'ambulance_updated_at', 'ambulance_eta_min',
  'ambulance_eta_source', 'zone', 'is_drill', 'created_at', 'updated_at',
];
const TARGET_COLUMNS = [
  'alert_id', 'hospital_id', 'hospital_name', 'round', 'distance_km', 'eta_min', 'eta_source', 'rank_score',
  'response', 'decline_reason', 'notified_at', 'responded_at', 'notify_result',
];
const HOSPITAL_WRITABLE = [
  'name', 'phone', 'email', 'webhook_url', 'address', 'facility_type', 'emergency_level', 'level_source', 'verified',
  'er_status', 'er_status_note', 'er_status_updated_at', 'er_status_updated_by',
];
const HOSPITAL_SELECT = 'id, name, phone, email, webhook_url, address, location, facility_type, emergency_level, level_source, beds, operator_type, verified, er_status, er_status_note, er_status_updated_at';

// How far back alerts are reloaded on startup (open alerts are always reloaded).
const HISTORY_DAYS = 30;
const PAGE = 1000;

const pick = (row, cols) => Object.fromEntries(cols.filter(k => row[k] !== undefined).map(k => [k, row[k]]));

/** DB timestamps arrive as ISO strings; the service compares Date objects. */
function reviveDates(row) {
  for (const k of Object.keys(row)) if (k.endsWith('_at') && typeof row[k] === 'string') row[k] = new Date(row[k]);
  return row;
}

/**
 * geography(Point) from PostgREST: hex EWKB ("0101000020E6100000…"), or GeoJSON /
 * EWKT depending on the PostGIS/PostgREST setup.
 */
export function pointOf(location) {
  const none = { lat: null, lng: null };
  if (!location) return none;
  if (typeof location === 'object' && Array.isArray(location.coordinates)) {
    return { lng: location.coordinates[0], lat: location.coordinates[1] };
  }
  const s = String(location);
  if (/^(00|01)[0-9a-f]{16,}$/i.test(s)) {
    const buf = Buffer.from(s, 'hex');
    const le = buf[0] === 1;
    const type = le ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
    if ((type & 0xff) !== 1) return none; // not a Point
    const at = 5 + (type & 0x20000000 ? 4 : 0); // skip SRID when present
    if (buf.length < at + 16) return none;
    const x = le ? buf.readDoubleLE(at) : buf.readDoubleBE(at);
    const y = le ? buf.readDoubleLE(at + 8) : buf.readDoubleBE(at + 8);
    return { lng: x, lat: y };
  }
  const m = s.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  return m ? { lng: parseFloat(m[1]), lat: parseFloat(m[2]) } : none;
}

const ewkt = (lat, lng) => (lat != null && lng != null ? `SRID=4326;POINT(${lng} ${lat})` : null);

// bytea over PostgREST is hex text: "\x0a1b…"
const toHex = (bytes) => '\\x' + Buffer.from(bytes).toString('hex');
const fromHex = (v) => (typeof v === 'string' && v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v || []));

async function selectAll(query) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

export function createSupabaseStore({ supabase, hospitals = [], logger = console, now = () => new Date() }) {
  let mem = createMemoryStore({ hospitals, now });
  let persist = false; // turned on once the tables are confirmed to exist
  let queue = Promise.resolve();

  /** Run DB writes one after another so an update never lands before its insert. */
  function write(label, fn) {
    if (!persist) return;
    queue = queue.then(async () => {
      try {
        const res = await fn();
        if (res?.error) throw new Error(res.error.message);
      } catch (e) {
        logger.warn?.(`[emergency] Supabase ${label} failed:`, e.message);
      }
    });
  }

  async function saveAlert(id) {
    const a = await mem.getAlert(id);
    if (a) write('alert save', () => supabase.from('emergency_alerts').upsert(pick(a, ALERT_COLUMNS)));
  }
  async function saveTargets(alertId) {
    const rows = (await mem.getTargets(alertId)).map(t => pick({ ...t, alert_id: alertId }, TARGET_COLUMNS));
    if (rows.length) write('targets save', () => supabase.from('emergency_alert_targets').upsert(rows, { onConflict: 'alert_id,hospital_id' }));
  }

  async function loadHospitals() {
    const rows = await selectAll(() => supabase.from('hospitals').select(HOSPITAL_SELECT).order('id'));
    if (rows.length) return rows.map(r => ({ ...r, ...pointOf(r.location), location: undefined }));

    // Empty table: seed it from seed-hospitals.json so the directory lives in Supabase.
    if (!hospitals.length) return [];
    const seed = hospitals.map(h => ({
      id: h.id, name: h.name, phone: h.phone ?? null, email: h.email ?? null, webhook_url: h.webhook_url ?? null,
      address: h.address ?? null, location: ewkt(h.lat, h.lng), osm_type: h.osm_type ?? h.osmType ?? null, osm_id: h.osm_id ?? h.osmId ?? null,
      facility_type: h.facility_type ?? 'hospital', emergency_level: h.emergency_level ?? 'general',
      level_source: h.level_source ?? null, beds: h.beds ?? null, operator_type: h.operator_type ?? null, source: 'osm',
    }));
    for (let i = 0; i < seed.length; i += 500) {
      const { error } = await supabase.from('hospitals').upsert(seed.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw new Error('seeding hospitals: ' + error.message);
    }
    logger.log?.(`[emergency] seeded ${seed.length} hospitals into Supabase`);
    return hospitals;
  }

  async function hydrate() {
    const hs = await loadHospitals();
    const fresh = createMemoryStore({ hospitals: hs, now });

    for (const u of await selectAll(() => supabase.from('hospital_users').select('*'))) {
      await fresh.linkHospitalUser({ userId: u.user_id, hospitalId: u.hospital_id, email: u.email, createdBy: u.created_by });
    }

    const since = new Date(now().getTime() - HISTORY_DAYS * 86400000).toISOString();
    const alerts = await selectAll(() => supabase.from('emergency_alerts').select('*')
      .or(`created_at.gte.${since},status.in.(new,accepted,dispatched,on_scene,transporting)`).order('created_at'));
    for (const a of alerts) await fresh.insertAlert(reviveDates(a));

    const ids = alerts.map(a => a.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const targets = await selectAll(() => supabase.from('emergency_alert_targets').select('*').in('alert_id', chunk).order('alert_id'));
      for (const t of targets) await fresh.upsertTarget(t.alert_id, t.hospital_id, reviveDates(t));
    }
    mem = fresh;
    return { hospitals: hs.length, alerts: alerts.length };
  }

  return {
    kind: 'supabase',

    async ready() {
      try {
        const { hospitals: nh, alerts: na } = await hydrate();
        persist = true;
        logger.log?.(`[emergency] Supabase store loaded ${nh} hospitals, ${na} recent alerts`);
      } catch (e) {
        logger.warn?.('[emergency] Supabase emergency tables unavailable — run Database/supabase-setup.sql. Alerts are not persisted until then:', e.message);
      }
    },
    /** Resolves once every queued write has been sent (tests / graceful shutdown). */
    flush() { return queue; },

    // ── Hospitals ──────────────────────────────────────────────────────────
    nearestHospitals: (...a) => mem.nearestHospitals(...a),
    getHospital: (...a) => mem.getHospital(...a),
    getHospitals: (...a) => mem.getHospitals(...a),
    searchHospitals: (...a) => mem.searchHospitals(...a),
    hospitalStats: (...a) => mem.hospitalStats(...a),
    listDispatchableHospitals: (...a) => mem.listDispatchableHospitals(...a),
    async updateHospital(id, patch) {
      const h = await mem.updateHospital(id, patch);
      const fields = pick(patch, HOSPITAL_WRITABLE);
      if (h && Object.keys(fields).length) {
        write('hospital update', () => supabase.from('hospitals').update({ ...fields, updated_at: now() }).eq('id', id));
      }
      return h;
    },

    // ── Hospital accounts ──────────────────────────────────────────────────
    getHospitalUser: (...a) => mem.getHospitalUser(...a),
    listHospitalUsers: (...a) => mem.listHospitalUsers(...a),
    async linkHospitalUser(args) {
      const row = await mem.linkHospitalUser(args);
      write('hospital user link', () => supabase.from('hospital_users').upsert(row, { onConflict: 'user_id' }));
      return row;
    },
    async unlinkHospitalUser(userId) {
      const ok = await mem.unlinkHospitalUser(userId);
      write('hospital user unlink', () => supabase.from('hospital_users').delete().eq('user_id', String(userId)));
      return ok;
    },

    // ── Alerts ─────────────────────────────────────────────────────────────
    async insertAlert(alert) {
      const row = await mem.insertAlert(alert);
      await saveAlert(row.id);
      return row;
    },
    getAlert: (...a) => mem.getAlert(...a),
    async updateAlert(id, patch, opts) {
      const row = await mem.updateAlert(id, patch, opts);
      if (row) await saveAlert(id);
      return row;
    },
    async addTokenHash(id, column, hash) {
      const row = await mem.addTokenHash(id, column, hash);
      if (row) await saveAlert(id);
      return row;
    },
    findOpenAlertNear: (...a) => mem.findOpenAlertNear(...a),
    listAlerts: (...a) => mem.listAlerts(...a),
    dueForEscalation: (...a) => mem.dueForEscalation(...a),
    alertsForMetrics: (...a) => mem.alertsForMetrics(...a),
    async deleteDrills() {
      const n = await mem.deleteDrills();
      write('drill cleanup', () => supabase.from('emergency_alerts').delete().eq('is_drill', true));
      return n;
    },

    // ── Targets ────────────────────────────────────────────────────────────
    async addTargets(alertId, rows) {
      await mem.addTargets(alertId, rows);
      await saveTargets(alertId);
      await saveAlert(alertId); // notified_hospital_ids changed
    },
    async upsertTarget(alertId, hospitalId, patch) {
      const row = await mem.upsertTarget(alertId, hospitalId, patch);
      await saveTargets(alertId);
      return row;
    },
    async markPendingTargets(alertId, response, exceptHospitalId) {
      await mem.markPendingTargets(alertId, response, exceptHospitalId);
      await saveTargets(alertId);
    },
    getTargets: (...a) => mem.getTargets(...a),
    getTargetsForAlerts: (...a) => mem.getTargetsForAlerts(...a),

    // ── Events & photos (Supabase is the record; memory covers this run) ────
    async addEvent(ev) {
      const row = await mem.addEvent(ev);
      const { id, ...rest } = row;
      write('event save', () => supabase.from('emergency_alert_events').insert(rest));
      return row;
    },
    async getEvents(alertId) {
      if (persist) {
        await queue;
        const { data, error } = await supabase.from('emergency_alert_events').select('*').eq('alert_id', alertId).order('created_at').order('id');
        if (!error) return data.map(reviveDates);
      }
      return mem.getEvents(alertId);
    },
    async addPhoto(alertId, mime, bytes) {
      const row = await mem.addPhoto(alertId, mime, bytes);
      write('photo save', () => supabase.from('emergency_alert_photos').insert({ alert_id: alertId, mime, bytes: toHex(bytes) }));
      await saveAlert(alertId); // photo_count changed
      return row;
    },
    async getPhoto(alertId, index = null) {
      const local = await mem.getPhoto(alertId, index);
      if (local || !persist) return local;
      await queue;
      let query = supabase.from('emergency_alert_photos').select('mime, bytes').eq('alert_id', alertId);
      query = index == null ? query.order('id', { ascending: false }).limit(1) : query.order('id').range(index, index);
      const { data, error } = await query;
      if (error || !data?.length) return null;
      return { mime: data[0].mime, bytes: fromHex(data[0].bytes) };
    },
  };
}

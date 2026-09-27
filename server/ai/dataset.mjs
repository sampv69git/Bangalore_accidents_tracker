/**
 * Unified, cached access to accident records for the AI features.
 *
 * Reads from every configured source (Supabase REST, direct Postgres, local
 * JSON fallback), merges rows by id and normalises them into one shape:
 *   { id, title, location, area, zone, severity, score, date, hour, dow,
 *     lat, lng, status, description, source, reporterId, proofUrl, createdAt, isUser }
 * All analysis runs server-side on this in-memory copy; nothing is sent to the browser in bulk.
 */
import fs from 'fs';

const SEVERITIES = new Set(['fatal', 'serious', 'minor']);

/** Format a JS Date (as returned by node-postgres for DATE columns) as local YYYY-MM-DD. */
function localIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normaliseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : localIsoDate(v);
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseHour(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Parse a PostGIS point in any representation Supabase/pg may return. */
export function parseGeom(geom) {
  if (!geom) return null;
  if (typeof geom === 'object' && Array.isArray(geom.coordinates)) {
    return { lng: Number(geom.coordinates[0]), lat: Number(geom.coordinates[1]) };
  }
  const s = String(geom);
  const wkt = s.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (wkt) return { lng: parseFloat(wkt[1]), lat: parseFloat(wkt[2]) };
  // Hex (E)WKB point, e.g. 0101000020E6100000 + x + y
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 42) {
    try {
      const buf = Buffer.from(s, 'hex');
      const le = buf[0] === 1;
      const type = le ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
      const hasSrid = (type & 0x20000000) !== 0;
      const off = 5 + (hasSrid ? 4 : 0);
      const x = le ? buf.readDoubleLE(off) : buf.readDoubleBE(off);
      const y = le ? buf.readDoubleLE(off + 8) : buf.readDoubleBE(off + 8);
      if (Number.isFinite(x) && Number.isFinite(y)) return { lng: x, lat: y };
    } catch { /* ignore */ }
  }
  return null;
}

export function normaliseRecord(r) {
  let lat = r.lat ?? r.latitude ?? null;
  let lng = r.lng ?? r.longitude ?? null;
  if ((lat == null || lng == null) && r.geom) {
    const g = parseGeom(r.geom);
    if (g) { lat = g.lat; lng = g.lng; }
  }
  lat = lat == null ? null : Number(lat);
  lng = lng == null ? null : Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { lat = null; lng = null; }

  const date = normaliseDate(r.accident_date) || normaliseDate(r.date) || normaliseDate(r.date_raw);
  const hour = parseHour(r.date_raw, r.time);
  const dow = date ? new Date(`${date}T12:00:00Z`).getUTCDay() : null;
  const severity = SEVERITIES.has(r.severity) ? r.severity : 'minor';
  const reporterId = r.reporter_id || r.reporterId || null;
  return {
    id: String(r.id),
    title: r.title || '',
    location: r.location || '',
    area: r.area || '',
    zone: r.zone || '',
    severity,
    score: r.score == null ? null : Number(r.score),
    date,
    hour,
    dow,
    lat,
    lng,
    status: r.status || 'active',
    description: r.description || '',
    source: r.source || '',
    link: r.link || null,
    reporterId,
    proofUrl: r.proof_url || r.proofUrl || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    isUser: Boolean(reporterId) || r.source === 'User Report' || r.source === 'user',
  };
}

function mergeRows(base, overlay) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

export function createDataset({ supabase = null, pool = null, jsonPath = null, ttlMs = 2 * 60 * 1000, logger = console } = {}) {
  let cache = null;
  let cacheAt = 0;
  let inflight = null;
  let lastSources = [];

  async function fromSupabase() {
    if (!supabase) return [];
    const rows = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await supabase.from('accidents').select('*').range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return rows;
  }

  async function fromPool() {
    if (!pool) return [];
    const res = await pool.query(`SELECT *, ST_Y(geom) AS lat, ST_X(geom) AS lng FROM accidents`);
    return res.rows.map(({ geom, ...rest }) => rest);
  }

  function fromJson() {
    if (!jsonPath || !fs.existsSync(jsonPath)) return [];
    const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return list.map(d => ({ ...d, status: d.status || 'active', lat: d.hasCoords === false ? null : d.lat, lng: d.hasCoords === false ? null : d.lng }));
  }

  async function load() {
    const byId = new Map();
    const sources = [];
    const [sb, pg] = await Promise.allSettled([fromSupabase(), fromPool()]);
    for (const [name, res] of [['supabase', sb], ['postgres', pg]]) {
      if (res.status === 'fulfilled' && res.value.length) {
        sources.push(name);
        for (const row of res.value) {
          const id = String(row.id);
          byId.set(id, byId.has(id) ? mergeRows(byId.get(id), row) : row);
        }
      } else if (res.status === 'rejected') {
        logger.warn?.(`[ai/dataset] ${name} load failed: ${res.reason?.message || res.reason}`);
      }
    }
    if (!byId.size) {
      try {
        for (const row of fromJson()) byId.set(String(row.id), row);
        if (byId.size) sources.push('local-json');
      } catch (e) {
        logger.warn?.(`[ai/dataset] JSON fallback failed: ${e.message}`);
      }
    }
    lastSources = sources;
    return [...byId.values()].map(normaliseRecord);
  }

  async function all() {
    if (cache && Date.now() - cacheAt < ttlMs) return cache;
    if (!inflight) {
      inflight = load()
        .then(rows => { cache = rows; cacheAt = Date.now(); return rows; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    /** All records (any status). */
    all,
    /** Active, geocoded records — what the public map shows. */
    async active() {
      return (await all()).filter(r => r.status === 'active' && r.lat != null);
    },
    async byId(id) {
      return (await all()).find(r => r.id === String(id)) || null;
    },
    invalidate() { cache = null; cacheAt = 0; },
    sources() { return lastSources.slice(); },
  };
}

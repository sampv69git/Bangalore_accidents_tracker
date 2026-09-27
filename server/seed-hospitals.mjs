/**
 * Seed / refresh the hospitals table from OpenStreetMap.
 *
 *   node seed-hospitals.mjs              fetch from Overpass (falls back to the cached copy)
 *   node seed-hospitals.mjs --offline    skip Overpass; use data/osm-hospitals.raw.json or seed-hospitals.json
 *   node seed-hospitals.mjs --dry-run    classify + report only, no database writes
 *   node seed-hospitals.mjs --no-prune   keep rows that are no longer in the source
 *
 * Every row gets a collision-free id (OSM element id, or a SHA-1 of the full
 * name + position), a facility type and an emergency capability level, then
 * duplicates of the same facility are merged. Rows an admin verified, manual
 * rows, and hospitals linked to a hospital account are never pruned.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { fromOsmElement, fromSeedRow, dedupeHospitals } from './emergency/hospitals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const DRY_RUN = args.has('--dry-run');
const PRUNE = !args.has('--no-prune');

const RAW_CACHE = path.join(__dirname, 'data', 'osm-hospitals.raw.json');
const SEED_JSON = path.join(__dirname, 'seed-hospitals.json');
const MIGRATION = path.join(__dirname, '..', 'Database', 'emergency.sql');
const BBOX = '12.5,77.0,13.5,78.2'; // south,west,north,east — matches the accidents bbox

async function fetchOverpass() {
  const query = `[out:json][timeout:120];
(
  nwr["amenity"="hospital"](${BBOX});
  nwr["healthcare"="hospital"](${BBOX});
);
out tags center;`;
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  let lastErr = null;
  for (const url of mirrors) {
    try {
      console.log(`  trying ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'BangaloreAccidentsTracker/1.0 (student project)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.elements) || !data.elements.length) throw new Error('empty response');
      return data;
    } catch (e) {
      lastErr = new Error(`${url}: ${e.message}`);
      console.warn(`  ${lastErr.message}`);
    }
  }
  throw lastErr;
}

async function loadSource() {
  if (!OFFLINE) {
    try {
      console.log('Fetching hospitals from Overpass…');
      const data = await fetchOverpass();
      fs.mkdirSync(path.dirname(RAW_CACHE), { recursive: true });
      fs.writeFileSync(RAW_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), elements: data.elements }));
      return { label: 'Overpass (live)', rows: data.elements.map(fromOsmElement) };
    } catch (e) {
      console.warn('Overpass unavailable, falling back to the cached copy:', e.message);
    }
  }
  if (fs.existsSync(RAW_CACHE)) {
    const raw = JSON.parse(fs.readFileSync(RAW_CACHE, 'utf8'));
    return { label: `cached OSM extract from ${raw.fetchedAt}`, rows: raw.elements.map(fromOsmElement) };
  }
  if (fs.existsSync(SEED_JSON)) {
    return { label: 'seed-hospitals.json', rows: JSON.parse(fs.readFileSync(SEED_JSON, 'utf8')).map(fromSeedRow) };
  }
  throw new Error('No hospital source available (Overpass down and no cached data).');
}

const countBy = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});

async function seed() {
  const { label, rows: rawRows } = await loadSource();
  const normalized = rawRows.filter(Boolean);
  const { rows, merged } = dedupeHospitals(normalized);
  console.log(`Source: ${label}`);
  console.log(`  ${rawRows.length} elements → ${normalized.length} named hospitals → ${rows.length} after merging ${merged} duplicates`);
  console.log('  facility types:', countBy(rows, 'facility_type'));
  console.log('  emergency levels:', countBy(rows, 'emergency_level'));

  const out = rows.map(r => ({
    id: r.id, osm_type: r.osmType || null, osm_id: r.osmId || null, name: r.name,
    phone: r.phone || null, address: r.address || null, lat: r.lat, lng: r.lng,
    facility_type: r.facility_type, emergency_level: r.emergency_level, level_source: r.level_source,
    beds: r.beds || null, operator_type: r.operator_type || null, emergency_tag: r.emergency_tag || null,
  }));

  if (DRY_RUN) { console.log('Dry run — nothing written.'); return; }

  // Local fallback used by the API when Postgres is unavailable.
  fs.writeFileSync(SEED_JSON, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} rows to seed-hospitals.json`);

  const databaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) { console.log('No DATABASE_URL — skipped database update.'); return; }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query(fs.readFileSync(MIGRATION, 'utf8'));
    await client.query('BEGIN');
    const before = (await client.query('SELECT count(*)::int AS n FROM hospitals')).rows[0].n;
    await client.query(
      `INSERT INTO hospitals (id, name, phone, address, location, osm_type, osm_id, facility_type, emergency_level, level_source, beds, operator_type, source, updated_at)
       SELECT r.id, r.name, r.phone, r.address, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geography,
              r.osm_type, r.osm_id, r.facility_type, r.emergency_level, r.level_source, r.beds, r.operator_type, 'osm', now()
       FROM jsonb_to_recordset($1::jsonb) AS r(id text, name text, phone text, address text, lat float8, lng float8,
            osm_type text, osm_id bigint, facility_type text, emergency_level text, level_source text, beds int, operator_type text)
       ON CONFLICT (id) DO UPDATE SET
         name            = CASE WHEN hospitals.verified THEN hospitals.name ELSE EXCLUDED.name END,
         phone           = CASE WHEN hospitals.verified THEN hospitals.phone ELSE COALESCE(EXCLUDED.phone, hospitals.phone) END,
         address         = CASE WHEN hospitals.verified THEN hospitals.address ELSE COALESCE(EXCLUDED.address, hospitals.address) END,
         location        = EXCLUDED.location,
         osm_type        = EXCLUDED.osm_type,
         osm_id          = EXCLUDED.osm_id,
         facility_type   = CASE WHEN hospitals.verified THEN hospitals.facility_type ELSE EXCLUDED.facility_type END,
         emergency_level = CASE WHEN hospitals.verified OR hospitals.level_source = 'admin' THEN hospitals.emergency_level ELSE EXCLUDED.emergency_level END,
         level_source    = CASE WHEN hospitals.verified OR hospitals.level_source = 'admin' THEN hospitals.level_source ELSE EXCLUDED.level_source END,
         beds            = COALESCE(EXCLUDED.beds, hospitals.beds),
         operator_type   = COALESCE(EXCLUDED.operator_type, hospitals.operator_type),
         updated_at      = now()`,
      [JSON.stringify(out)]
    );
    let pruned = 0;
    if (PRUNE) {
      const del = await client.query(
        `DELETE FROM hospitals h
         WHERE NOT (h.id = ANY($1::text[]))
           AND h.verified = FALSE
           AND COALESCE(h.source, 'osm') = 'osm'
           AND NOT EXISTS (SELECT 1 FROM hospital_users u WHERE u.hospital_id = h.id)`,
        [out.map(r => r.id)]
      );
      pruned = del.rowCount;
    }
    await client.query('COMMIT');
    const after = (await client.query('SELECT count(*)::int AS n FROM hospitals')).rows[0].n;
    console.log(`Database: ${before} rows before → ${after} after (upserted ${out.length}, pruned ${pruned} stale rows)`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
  console.log('Seeding complete');
}

seed().catch(e => { console.error('Seeding failed:', e.message); process.exit(1); });

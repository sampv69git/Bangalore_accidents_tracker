import { describe, it, expect } from 'vitest';
import { createSupabaseStore, pointOf } from '../emergency/store-supabase.mjs';

// Exactly what Supabase returns for hospitals.location (geography) — Swamy Hospital.
const SWAMY_EWKB = '0101000020E61000000A88A471836A53406F1283C0CAB52940';

describe('pointOf', () => {
  it('decodes hex EWKB, GeoJSON and EWKT points', () => {
    expect(pointOf(SWAMY_EWKB)).toEqual({ lat: 12.8550625, lng: 77.6642727 });
    expect(pointOf({ type: 'Point', coordinates: [77.6, 12.9] })).toEqual({ lat: 12.9, lng: 77.6 });
    expect(pointOf('SRID=4326;POINT(77.6 12.9)')).toEqual({ lat: 12.9, lng: 77.6 });
    expect(pointOf(null)).toEqual({ lat: null, lng: null });
  });
});

/** Minimal PostgREST-style fake: tables are arrays; supports the calls the store makes. */
function fakeSupabase(initial = {}, { missing = [] } = {}) {
  const tables = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v.map(r => ({ ...r }))]));
  const keyOf = { hospitals: ['id'], hospital_users: ['user_id'], emergency_alerts: ['id'], emergency_alert_targets: ['alert_id', 'hospital_id'] };
  let seq = 0;

  function from(name) {
    const filters = [];
    let op = 'select', payload = null, range = null, limit = null;
    const rows = () => (tables[name] ||= []);
    const matchAll = r => filters.every(f => f(r));
    const b = {
      select() { return b; },
      order() { return b; },
      or() { return b; },
      range(a, z) { range = [a, z]; return b; },
      limit(n) { limit = n; return b; },
      eq(k, v) { filters.push(r => r[k] === v); return b; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return b; },
      insert(p) { op = 'insert'; payload = [].concat(p); return b; },
      upsert(p) { op = 'upsert'; payload = [].concat(p); return b; },
      update(p) { op = 'update'; payload = p; return b; },
      delete() { op = 'delete'; return b; },
      then(resolve, reject) {
        try {
          if (missing.includes(name)) return resolve({ data: null, error: { message: `relation "${name}" does not exist` } });
          const json = x => JSON.parse(JSON.stringify(x)); // what goes over the wire
          if (op === 'insert') { for (const r of payload) rows().push({ id: ++seq, ...json(r) }); return resolve({ data: null, error: null }); }
          if (op === 'upsert') {
            const keys = keyOf[name] || ['id'];
            for (const r of payload.map(json)) {
              const i = rows().findIndex(x => keys.every(k => x[k] === r[k]));
              if (i >= 0) Object.assign(rows()[i], r); else rows().push(r);
            }
            return resolve({ data: null, error: null });
          }
          if (op === 'update') { rows().filter(matchAll).forEach(r => Object.assign(r, json(payload))); return resolve({ data: null, error: null }); }
          if (op === 'delete') { tables[name] = rows().filter(r => !matchAll(r)); return resolve({ data: null, error: null }); }
          let out = rows().filter(matchAll);
          if (range) out = out.slice(range[0], range[1] + 1);
          if (limit != null) out = out.slice(0, limit);
          return resolve({ data: json(out), error: null });
        } catch (e) { return reject(e); }
      },
    };
    return b;
  }
  return { from, tables };
}

const quiet = { log() {}, warn() {} };
const seedHospitals = [
  { id: 'h1', name: 'City Trauma', lat: 12.97, lng: 77.59, emergency_level: 'trauma', osmType: 'node', osmId: 1 },
  { id: 'h2', name: 'Lakeside', lat: 12.93, lng: 77.62, emergency_level: 'emergency' },
];

describe('Supabase emergency store', () => {
  it('seeds an empty hospitals table and serves the directory', async () => {
    const sb = fakeSupabase();
    const store = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await store.ready();
    expect(sb.tables.hospitals).toHaveLength(2);
    expect(sb.tables.hospitals[0].location).toBe('SRID=4326;POINT(77.59 12.97)');
    expect(sb.tables.hospitals[0].osm_type).toBe('node');
    expect((await store.searchHospitals({ q: 'city' })).total).toBe(1);
  });

  it('loads hospitals already in Supabase with usable coordinates for dispatch', async () => {
    const sb = fakeSupabase({ hospitals: [{ id: 'osm_n266740082', name: 'Swamy Hospital', location: SWAMY_EWKB, emergency_level: 'trauma' }] });
    const store = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await store.ready();
    const near = await store.nearestHospitals({ lat: 12.86, lng: 77.66, limit: 5 });
    expect(near.map(h => h.id)).toEqual(['osm_n266740082']);
    expect(near[0].lat).toBeCloseTo(12.8550625, 6);
    expect(sb.tables.hospitals).toHaveLength(1); // not re-seeded
  });

  it('writes alerts, targets, events and photos through to Supabase', async () => {
    const sb = fakeSupabase();
    const store = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await store.ready();

    await store.insertAlert({ id: 'a1', lat: 12.97, lng: 77.59, status: 'new', priority: 'urgent', severity: 'serious', triage: { injured: 2 } });
    await store.addTargets('a1', [{ hospital_id: 'h1', hospital_name: 'City Trauma', round: 0, eta_min: 6 }]);
    await store.updateAlert('a1', { status: 'accepted', accepted_hospital_id: 'h1' }, { expect: { status: 'new' } });
    await store.upsertTarget('a1', 'h1', { response: 'accepted' });
    await store.addEvent({ alert_id: 'a1', type: 'accepted', hospital_id: 'h1' });
    await store.addPhoto('a1', 'image/jpeg', Buffer.from([1, 2, 3]));
    await store.flush();

    const saved = sb.tables.emergency_alerts[0];
    expect(saved).toMatchObject({ id: 'a1', status: 'accepted', accepted_hospital_id: 'h1', notified_hospital_ids: ['h1'], photo_count: 1 });
    expect(saved.triage).toEqual({ injured: 2 });
    expect(sb.tables.emergency_alert_targets).toEqual([expect.objectContaining({ alert_id: 'a1', hospital_id: 'h1', response: 'accepted' })]);
    expect(sb.tables.emergency_alert_events[0]).toMatchObject({ alert_id: 'a1', type: 'accepted' });
    expect(sb.tables.emergency_alert_photos[0]).toMatchObject({ alert_id: 'a1', mime: 'image/jpeg', bytes: '\\x010203' });
  });

  it('reloads alerts (with Date timestamps), targets and accounts after a restart', async () => {
    const sb = fakeSupabase();
    const first = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await first.ready();
    await first.insertAlert({ id: 'a1', lat: 12.97, lng: 77.59, status: 'new', next_escalation_at: new Date(Date.now() - 1000) });
    await first.addTargets('a1', [{ hospital_id: 'h1', round: 0 }]);
    await first.linkHospitalUser({ userId: 'u1', hospitalId: 'h1', email: 'er@city.test' });
    await first.addPhoto('a1', 'image/png', Buffer.from([9, 8]));
    await first.flush();

    const second = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await second.ready();
    const a = await second.getAlert('a1');
    expect(a.created_at).toBeInstanceOf(Date);
    expect(await second.dueForEscalation(new Date())).toHaveLength(1);
    expect((await second.getTargets('a1'))[0].hospital_id).toBe('h1');
    expect((await second.getHospitalUser('u1')).hospital.name).toBe('City Trauma');
    const photo = await second.getPhoto('a1');
    expect(photo.mime).toBe('image/png');
    expect([...photo.bytes]).toEqual([9, 8]);
  });

  it('keeps working in memory when the tables are missing', async () => {
    const sb = fakeSupabase({}, { missing: ['hospitals'] });
    const store = createSupabaseStore({ supabase: sb, hospitals: seedHospitals, logger: quiet });
    await store.ready();
    await store.insertAlert({ id: 'a1', lat: 12.97, lng: 77.59, status: 'new' });
    await store.flush();
    expect(await store.getAlert('a1')).toMatchObject({ id: 'a1' });
    expect(sb.tables.emergency_alerts).toBeUndefined();
    expect((await store.hospitalStats()).total).toBe(2);
  });
});

/**
 * Hospital classification, ids and de-duplication (seeder + dispatch rules),
 * triage → priority, and response metrics.
 */
import { describe, it, expect } from 'vitest';
import { classifyHospital, hospitalIdFor, dedupeHospitals, fromOsmElement, fromSeedRow, normalizeName } from '../emergency/hospitals.mjs';
import { normalizeTriage, mergeTriage, priorityFromTriage, severityFor, triageSummary } from '../emergency/triage.mjs';
import { computeResponseMetrics, quantile } from '../emergency/metrics.mjs';
import { accidentCells, summarize, deserts } from '../emergency/coverage.mjs';
import { zoneFor, tokenMatches, hashToken } from '../emergency/util.mjs';

describe('hospital ids', () => {
  it('no longer collide for same-named hospitals (old scheme truncated the name)', () => {
    const a = hospitalIdFor({ name: 'Apollo Hospital', lat: 12.9263, lng: 77.6765 });
    const b = hospitalIdFor({ name: 'Apollo Hospital', lat: 12.8950, lng: 77.5990 });
    expect(a).not.toBe(b);
    const legacy = (n, lat, lng) => 'hosp_' + Buffer.from(`${n}|${lat}|${lng}`).toString('base64url').slice(0, 20);
    expect(legacy('Apollo Hospital', 12.9263, 77.6765)).toBe(legacy('Apollo Hospital', 12.8950, 77.5990));
  });

  it('prefers the stable OSM identity', () => {
    expect(hospitalIdFor({ osmType: 'way', osmId: 44091445, name: 'x', lat: 1, lng: 2 })).toBe('osm_w44091445');
    expect(hospitalIdFor({ osmType: 'node', osmId: 7, name: 'x', lat: 1, lng: 2 })).toBe('osm_n7');
  });

  it('is deterministic for the same facility', () => {
    const p = { name: 'Sri Sai Hospital', lat: 12.97123456, lng: 77.5912345 };
    expect(hospitalIdFor(p)).toBe(hospitalIdFor({ ...p, name: 'SRI SAI HOSPITAL' }));
  });
});

describe('classifyHospital', () => {
  const level = (name, tags) => classifyHospital({ name, tags }).level;

  it('keeps non-trauma facilities out of dispatch', () => {
    expect(level('Narayana Hrudayalaya Dental Clinic')).toBe('none');
    expect(level('Narayana Nethralaya')).toBe('none');
    expect(level('Apollo Clinic')).toBe('none');
    expect(level('Cloudnine Hospital')).toBe('none');
    expect(level('SDS Tuberculosis Research Centre')).toBe('none');
    expect(level('Government Primary Health Centre')).toBe('none');
  });

  it('marks curated trauma centres, but not their OPD / department entries', () => {
    expect(level('Victoria Hospital')).toBe('trauma');
    expect(level('Sanjay Gandhi Accident and Trauma Hospital')).toBe('trauma');
    expect(classifyHospital({ name: 'Narayana Hrudayalaya' })).toMatchObject({ level: 'trauma', levelSource: 'curated' });
    expect(level('Emergency Block , NIMHANS')).toBe('trauma');
    expect(level('NIMHANS OPD')).toBe('none');
    expect(level('Manipal Hospital OPD')).toBe('none');
    expect(level('Sai Sparsh Hospital')).toBe('general'); // not the Sparsh chain
  });

  it('uses OSM emergency tags and name hints', () => {
    expect(classifyHospital({ name: 'Swamy Hospital', tags: { emergency: 'yes' } })).toMatchObject({ level: 'emergency', levelSource: 'osm' });
    expect(level('Swamy Hospital', { emergency: 'no' })).toBe('none');
    expect(level('Maiya Multispecialty Hospital')).toBe('emergency');
    expect(level('Government Hospital')).toBe('emergency');
    expect(level('Shanti Hospital')).toBe('general');
    expect(level('Dentist on 5th', { healthcare: 'dentist' })).toBe('none');
  });
});

describe('fromOsmElement / fromSeedRow / dedupe', () => {
  it('normalises Overpass elements', () => {
    const h = fromOsmElement({ type: 'way', id: 12, center: { lat: 12.9, lon: 77.6 }, tags: { name: 'Fortis Hospital', 'contact:phone': '+91 80 1234 5678; 080 999', emergency: 'yes', beds: '250' } });
    expect(h).toMatchObject({ id: 'osm_w12', lat: 12.9, lng: 77.6, phone: '+91 80 1234 5678', beds: 250, emergency_level: 'trauma' });
    expect(fromOsmElement({ type: 'node', id: 1, lat: 12.9, lon: 77.6, tags: {} })).toBeNull();
  });

  it('reads both old and new seed JSON rows', () => {
    expect(fromSeedRow({ name: 'Shanti Hospital', location: 'SRID=4326;POINT(77.5857517 12.9235041)' })).toMatchObject({ lat: 12.9235041, lng: 77.5857517 });
    expect(fromSeedRow({ name: 'X Hospital', osm_type: 'node', osm_id: 5, lat: 12.9, lng: 77.6 }).id).toBe('osm_n5');
  });

  it('merges a node and a building outline of the same hospital, not same-named hospitals far apart', () => {
    const rows = [
      fromOsmElement({ type: 'node', id: 1, lat: 12.9263, lon: 77.6765, tags: { name: 'Apollo Hospital' } }),
      fromOsmElement({ type: 'way', id: 2, center: { lat: 12.9270, lon: 77.6770 }, tags: { name: 'Apollo Hospitals', phone: '080 4022 2555' } }),
      fromOsmElement({ type: 'node', id: 3, lat: 12.8950, lon: 77.5990, tags: { name: 'Apollo Hospital' } }),
    ];
    const { rows: out, merged } = dedupeHospitals(rows);
    expect(merged).toBe(1);
    expect(out).toHaveLength(2);
    expect(out.find(h => h.id === 'osm_w2').phone).toBe('080 4022 2555');
    expect(normalizeName('The Apollo Hospitals Pvt Ltd')).toBe('apollo hospital');
  });
});

describe('triage', () => {
  it('normalises junk input', () => {
    expect(normalizeTriage({ injured: 7, conscious: 'maybe', vehicles: ['car', 'tank'], called_108: 'yes' }))
      .toMatchObject({ injured: 'unknown', conscious: 'unknown', vehicles: ['car'], called_108: true });
  });

  it('prioritises life-threatening answers as critical', () => {
    expect(priorityFromTriage({ breathing: 'no' }).priority).toBe('critical');
    expect(priorityFromTriage({ injured: '3+' }).priority).toBe('critical');
    expect(priorityFromTriage({ bleeding: 'yes' }).reasons).toContain('heavy bleeding');
    expect(priorityFromTriage({}, { visionSeverity: 'fatal' }).priority).toBe('critical');
  });

  it('treats unknown as urgent, and no injuries as standard', () => {
    expect(priorityFromTriage({}).priority).toBe('urgent');
    expect(priorityFromTriage({ injured: '0' }).priority).toBe('standard');
    expect(priorityFromTriage({ injured: '0' }, { visionSeverity: 'serious' }).priority).toBe('urgent');
  });

  it('merges reports keeping the worse answer', () => {
    const m = mergeTriage({ injured: '1', conscious: 'yes', vehicles: ['car'] }, { injured: '2', conscious: 'no', vehicles: ['two_wheeler'] });
    expect(m).toMatchObject({ injured: '2', conscious: 'no', vehicles: ['car', 'two_wheeler'] });
    expect(severityFor('critical')).toBe('serious');
    expect(severityFor('urgent', 'fatal')).toBe('fatal');
    expect(triageSummary({ injured: '2', breathing: 'no', called_108: true })).toBe('2 injured · NOT BREATHING · 108 called');
  });
});

describe('utils', () => {
  it('zones by position around the city centre', () => {
    expect(zoneFor(12.9716, 77.5946)).toBe('Central');
    expect(zoneFor(13.10, 77.59)).toBe('North');
    expect(zoneFor(12.85, 77.60)).toBe('South');
    expect(zoneFor(12.97, 77.75)).toBe('East');
    expect(zoneFor(12.97, 77.45)).toBe('West');
  });

  it('matches tokens only by hash', () => {
    expect(tokenMatches('abc', [hashToken('abc')])).toBe(true);
    expect(tokenMatches('abd', [hashToken('abc')])).toBe(false);
    expect(tokenMatches('', [hashToken('')])).toBe(false);
  });
});

describe('computeResponseMetrics', () => {
  const t0 = new Date('2026-09-20T04:30:00Z'); // 10:00 IST
  const at = (min) => new Date(t0.getTime() + min * 60000);
  const rows = [
    { id: 'a', status: 'closed', priority: 'critical', zone: 'South', created_at: t0, accepted_at: at(1), dispatched_at: at(2), on_scene_at: at(9), transporting_at: at(20), closed_at: at(40), escalation_round: 1, accepted_hospital_id: 'h1', accepted_hospital_name: 'H1', report_count: 2 },
    { id: 'b', status: 'closed', priority: 'urgent', zone: 'South', created_at: t0, accepted_at: at(3), on_scene_at: at(25), transporting_at: at(35), closed_at: at(70), escalation_round: 2, accepted_hospital_id: 'h1', accepted_hospital_name: 'H1' },
    { id: 'c', status: 'new', priority: 'urgent', zone: 'East', created_at: t0, escalation_exhausted_at: at(5), escalation_round: 3 },
    { id: 'd', status: 'cancelled', priority: 'standard', zone: 'East', created_at: t0, cancelled_at: at(2) },
  ];

  it('computes golden-hour KPIs', () => {
    const m = computeResponseMetrics(rows, { now: at(60), days: 7 });
    expect(m.summary).toMatchObject({ total: 4, accepted: 2, cancelled: 1, unanswered: 1, reached: 2, transported: 2, merged_reports: 1 });
    expect(m.summary.median_accept_min).toBe(2);
    expect(m.summary.within_10_min_pct).toBe(50);
    expect(m.summary.golden_hour_pct).toBe(50);
    expect(m.byZone.find(z => z.zone === 'South')).toMatchObject({ total: 2, reached: 2 });
    expect(m.byHour[10].total).toBe(4);
    expect(m.escalation).toEqual([{ round: 1, accepted: 1 }, { round: 2, accepted: 1 }]);
    expect(m.hospitals[0]).toMatchObject({ id: 'h1', accepted: 2 });
    expect(m.daily).toHaveLength(7);
  });

  it('quantile interpolates and ignores nulls', () => {
    expect(quantile([1, null, 3], 0.5)).toBe(2);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('coverage helpers', () => {
  it('groups accidents into ~1 km cells and ranks deserts by weight × delay', () => {
    const cells = accidentCells([
      { lat: 12.9170, lng: 77.6230, severity: 'fatal' },
      { lat: 12.9172, lng: 77.6232, severity: 'minor' },
      { lat: 13.0500, lng: 77.5000, severity: 'serious' },
    ]);
    expect(cells).toHaveLength(2);
    const silk = cells.find(c => c.accidents === 2);
    expect(silk).toMatchObject({ fatal: 1, minor: 1, weight: 4 });
    const withEta = cells.map(c => ({ ...c, eta_min: c.accidents === 2 ? 8 : 25, trauma_eta_min: 30 }));
    expect(summarize(withEta)).toMatchObject({ accidents: 3, within_10_min_pct: 66.7, over_20_min_pct: 33.3, trauma_within_30_min_pct: 100 });
    expect(deserts(withEta).map(d => d.desert_score)).toEqual([30]);
  });
});

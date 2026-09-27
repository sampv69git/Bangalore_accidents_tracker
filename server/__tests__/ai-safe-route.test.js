import { describe, it, expect, vi } from 'vitest';
import { scoreRoute, chooseSafest, suggestSafeRoute, parseLatLng, detourVias } from '../ai/safe-route.mjs';
import { PointIndex, haversineKm } from '../ai/geo.mjs';
import { makeRecord, jsonResponse } from './fixtures/ai-fixtures.js';

// Two parallel west→east routes ~1.1 km apart; incidents sit on the northern one.
const north = [[77.60, 12.98], [77.63, 12.98]];
const south = [[77.60, 12.97], [77.61, 12.965], [77.62, 12.965], [77.63, 12.97]];
const incidents = Array.from({ length: 12 }, (_, i) => makeRecord({ id: `n${i}`, lat: 12.9801, lng: 77.602 + i * 0.002, severity: i % 3 === 0 ? 'fatal' : 'minor' }));

describe('scoreRoute', () => {
  const index = new PointIndex(incidents);
  it('penalises the route that passes recorded incidents', () => {
    const a = scoreRoute({ coordinates: north, distanceKm: 3.2, durationMin: 8 }, { index });
    const b = scoreRoute({ coordinates: south, distanceKm: 3.5, durationMin: 9 }, { index });
    expect(a.incidentsNearby).toBe(12);
    expect(b.incidentsNearby).toBe(0);
    expect(a.bySeverity.fatal).toBe(4);
    expect(a.safetyScore).toBeLessThan(b.safetyScore);
    expect(b.safetyScore).toBe(100);
  });
});

describe('chooseSafest', () => {
  it('prefers lower danger unless the detour is unreasonable', () => {
    const fast = { durationMin: 10, weightedExposure: 20, predictedRisk: 1 };
    const safe = { durationMin: 12, weightedExposure: 2, predictedRisk: 0.2 };
    const huge = { durationMin: 40, weightedExposure: 0, predictedRisk: 0 };
    const { best, fastestRoute } = chooseSafest([fast, safe, huge]);
    expect(fastestRoute).toBe(fast);
    expect(best).toBe(safe);
  });

  it('keeps the fastest route when the alternative is only marginally safer', () => {
    const fast = { durationMin: 10, weightedExposure: 20, predictedRisk: 1 };
    const slightly = { durationMin: 15, weightedExposure: 20, predictedRisk: 0.9 };
    expect(chooseSafest([fast, slightly]).best).toBe(fast);
  });
});

describe('helpers', () => {
  it('parses "lat,lng" only inside the Bengaluru region', () => {
    expect(parseLatLng('12.97, 77.59')).toEqual({ lat: 12.97, lng: 77.59 });
    expect(parseLatLng('28.6, 77.2')).toBeNull();
    expect(parseLatLng('Koramangala')).toBeNull();
  });

  it('places detour via-points on either side of the straight line', () => {
    const from = { lat: 12.97, lng: 77.60 }, to = { lat: 12.97, lng: 77.70 };
    const [a, b] = detourVias(from, to);
    expect(a.lat).toBeGreaterThan(12.97);
    expect(b.lat).toBeLessThan(12.97);
    expect(haversineKm(a.lat, a.lng, 12.97, 77.65)).toBeGreaterThan(2);
  });
});

describe('suggestSafeRoute', () => {
  it('scores OSRM alternatives and recommends the safer one', async () => {
    const osrm = { code: 'Ok', routes: [
      { distance: 3200, duration: 480, geometry: { coordinates: north } },
      { distance: 3500, duration: 540, geometry: { coordinates: south } },
    ] };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(osrm));
    const out = await suggestSafeRoute({ from: { lat: 12.975, lng: 77.60 }, to: { lat: 12.975, lng: 77.63 }, records: incidents, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('alternatives=3');
    expect(out.routes).toHaveLength(2);
    const rec = out.routes.find(r => r.recommended);
    expect(rec.incidentsNearby).toBe(0);
    expect(out.summary).toMatch(/Safer alternative/);
    expect(out.disclaimer).toMatch(/historical/);
  });

  it('rejects points outside Bengaluru', async () => {
    await expect(suggestSafeRoute({ from: { lat: 28.6, lng: 77.2 }, to: { lat: 12.97, lng: 77.6 }, records: [] })).rejects.toThrow(/Bengaluru/);
  });
});

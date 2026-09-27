/**
 * Safe-route suggestion.
 *
 * Free services only:
 *  - Routing: OSRM public demo server (router.project-osrm.org) — no key.
 *    Override with OSRM_URL if you self-host OSRM (also free).
 *  - Geocoding: OpenStreetMap Nominatim — no key, max 1 request/second.
 *
 * Each candidate route is scored by the historical incidents within a buffer
 * of the path (severity-weighted, distance-decayed) plus the predicted risk of
 * the grid cells it passes through. The recommended route is the lowest-danger
 * route that is not an unreasonable detour.
 */
import { densify, polylineKm, haversineKm, PointIndex } from './geo.mjs';
import { riskAt } from './risk-model.mjs';

const UA = 'BangaloreAccidentsTracker/1.0 (student project)';
const SEV_WEIGHT = { fatal: 3, serious: 2, minor: 1 };
export const BUFFER_M = 120;

// Bangalore metropolitan bounding box (matches report validation).
const BBOX = { minLat: 12.5, maxLat: 13.5, minLng: 77.0, maxLng: 78.2 };
const inBbox = (p) => p.lat >= BBOX.minLat && p.lat <= BBOX.maxLat && p.lng >= BBOX.minLng && p.lng <= BBOX.maxLng;

// ── Polite, cached access to free public services ───────────────────────────

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  return value;
}

let nominatimChain = Promise.resolve();
/** Serialise Nominatim calls to respect its 1 request/second usage policy. */
function nominatimThrottle(fn) {
  const run = nominatimChain.then(fn);
  nominatimChain = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, 1100)));
  return run;
}

export function parseLatLng(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const p = { lat: Number(m[1]), lng: Number(m[2]) };
  return inBbox(p) ? p : null;
}

export async function geocodePlace(text, { fetchImpl = globalThis.fetch } = {}) {
  const direct = parseLatLng(text);
  if (direct) return { ...direct, label: `${direct.lat.toFixed(5)}, ${direct.lng.toFixed(5)}` };
  const q = String(text || '').trim();
  if (!q) throw new Error('Empty place name');
  return cached(`geo:${q.toLowerCase()}`, 24 * 3600 * 1000, () => nominatimThrottle(async () => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Bengaluru')}&viewbox=77.35,13.25,77.85,12.7&bounded=1&format=json&limit=1`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Geocoding failed (HTTP ${res.status})`);
    const data = await res.json();
    if (!data?.length) throw new Error(`Could not find "${q}" in Bengaluru`);
    return { lat: Number(data[0].lat), lng: Number(data[0].lon), label: data[0].display_name };
  }));
}

async function osrm(points, { alternatives = true, fetchImpl = globalThis.fetch } = {}) {
  const base = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false${alternatives ? '&alternatives=3' : ''}`;
  return cached(`osrm:${url}`, 15 * 60 * 1000, async () => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Routing service error (HTTP ${res.status})`);
    const body = await res.json();
    if (body.code !== 'Ok' || !body.routes?.length) throw new Error(body.message || 'No route found');
    return body.routes.map(r => ({ distanceKm: r.distance / 1000, durationMin: r.duration / 60, coordinates: r.geometry.coordinates }));
  });
}

/** Via-points offset perpendicular to the straight line, used to force distinct alternatives. */
export function detourVias(from, to, fraction = 0.25) {
  const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  const kx = Math.cos(mid.lat * Math.PI / 180);
  const dx = (to.lng - from.lng) * kx, dy = to.lat - from.lat;
  const len = Math.hypot(dx, dy) || 1e-9;
  const nx = -dy / len, ny = dx / len;
  const off = len * fraction;
  return [1, -1].map(s => ({ lat: mid.lat + s * ny * off, lng: mid.lng + (s * nx * off) / kx }));
}

/** Fraction of route A's sample points that lie within `tolM` of route B. */
function overlap(a, b, tolM = 40) {
  const idx = new PointIndex(densify(b.coordinates, 60), 0.002);
  const pts = densify(a.coordinates, 120);
  if (!pts.length) return 1;
  return pts.filter(p => idx.near(p.lat, p.lng, tolM).length > 0).length / pts.length;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export function scoreRoute(route, { index, model = null, bufferM = BUFFER_M }) {
  const samples = densify(route.coordinates, 40);
  const seen = new Map();
  for (const s of samples) {
    for (const p of index.near(s.lat, s.lng, bufferM)) {
      const d = haversineKm(s.lat, s.lng, p.lat, p.lng) * 1000;
      const prev = seen.get(p.id);
      if (!prev || d < prev.d) seen.set(p.id, { p, d });
    }
  }
  let exposure = 0;
  const bySev = { fatal: 0, serious: 0, minor: 0 };
  for (const { p, d } of seen.values()) {
    exposure += (SEV_WEIGHT[p.severity] || 1) * (1 - 0.5 * d / bufferM);
    bySev[p.severity] = (bySev[p.severity] || 0) + 1;
  }

  let predicted = 0, hotCells = new Map();
  if (model) {
    for (const s of samples) {
      const c = riskAt(model, s.lat, s.lng);
      predicted += c.expected || 0;
      if (c.level === 'high' || c.level === 'very_high') hotCells.set(c.key, c);
    }
    predicted /= Math.max(1, samples.length);
  }

  const km = route.distanceKm || polylineKm(route.coordinates);
  const perKm = exposure / Math.max(0.5, km);
  const incidents = [...seen.values()]
    .sort((a, b) => (SEV_WEIGHT[b.p.severity] - SEV_WEIGHT[a.p.severity]) || a.d - b.d)
    .map(({ p, d }) => ({ id: p.id, lat: p.lat, lng: p.lng, severity: p.severity, title: p.title, location: p.location || p.area, date: p.date, distanceM: Math.round(d) }));

  return {
    distanceKm: Math.round(km * 100) / 100,
    durationMin: Math.round(route.durationMin * 10) / 10,
    incidentsNearby: seen.size,
    bySeverity: bySev,
    weightedExposure: Math.round(exposure * 100) / 100,
    exposurePerKm: Math.round(perKm * 100) / 100,
    predictedRisk: Math.round(predicted * 1000) / 1000,
    hotspotCellsCrossed: hotCells.size,
    hotspots: [...hotCells.values()].sort((a, b) => b.expected - a.expected)
      .filter((c, i, arr) => !c.name || arr.findIndex(o => o.name === c.name) === i).slice(0, 5)
      .map(c => ({ lat: c.lat, lng: c.lng, level: c.level, name: c.name || null, pastIncidents: c.pastIncidents })),
    incidents: incidents.slice(0, 40),
    // 100 = no recorded incidents along the way; drops as severity-weighted incidents per km rise.
    safetyScore: Math.round(100 * Math.exp(-0.35 * perKm)),
  };
}

/** Pick the recommended route: lowest danger among routes at most 40% slower than the fastest. */
export function chooseSafest(scored) {
  const fastest = Math.min(...scored.map(r => r.durationMin));
  const maxPred = Math.max(1e-9, ...scored.map(r => r.predictedRisk));
  const maxExp = Math.max(1e-9, ...scored.map(r => r.weightedExposure));
  scored.forEach(r => { r.danger = Math.round((0.7 * r.weightedExposure / maxExp + 0.3 * r.predictedRisk / maxPred) * 1000) / 1000; });
  const eligible = scored.filter(r => r.durationMin <= fastest * 1.4 + 3);
  const fastestRoute = scored.find(r => r.durationMin === fastest);
  let best = eligible.reduce((a, b) => (b.danger < a.danger ? b : a), eligible[0]);
  // Only suggest a slower route when it is meaningfully safer (≥15% lower danger).
  if (best !== fastestRoute && best.danger > fastestRoute.danger * 0.85) best = fastestRoute;
  return { best, fastestRoute };
}

function reductionPct(better, worse) {
  return worse > 0 ? Math.round((1 - better / worse) * 100) : 0;
}

export async function suggestSafeRoute({ from, to, records, model = null, fetchImpl = globalThis.fetch }) {
  if (!inBbox(from) || !inBbox(to)) throw new Error('Both points must be inside the Bengaluru region');
  if (haversineKm(from.lat, from.lng, to.lat, to.lng) < 0.2) throw new Error('Start and destination are too close together');

  let routes = await osrm([from, to], { fetchImpl });
  if (routes.length < 2) {
    // The public server often returns a single route; ask for detours through offset via-points.
    for (const via of detourVias(from, to)) {
      try {
        const [r] = await osrm([from, via, to], { alternatives: false, fetchImpl });
        if (r) routes.push(r);
      } catch { /* a detour failing is fine */ }
    }
  }
  const unique = [];
  for (const r of routes) {
    if (!unique.some(u => overlap(r, u) > 0.9)) unique.push(r);
  }

  const pts = records.filter(r => r.lat != null && r.status === 'active');
  const index = new PointIndex(pts, 0.002);
  const scored = unique.slice(0, 4).map((r, i) => ({ id: i, ...scoreRoute(r, { index, model }), geometry: { type: 'LineString', coordinates: r.coordinates } }));
  const { best, fastestRoute } = chooseSafest(scored);
  scored.forEach(r => { r.recommended = r === best; r.fastest = r === fastestRoute; });

  let summary;
  if (scored.length === 1) {
    summary = `Only one practical route was found. It passes ${best.incidentsNearby} recorded incident(s) within ${BUFFER_M} m.`;
  } else if (best === fastestRoute) {
    summary = `The fastest route is also the safest: ${best.incidentsNearby} recorded incident(s) within ${BUFFER_M} m, safety score ${best.safetyScore}/100.`;
  } else {
    const fewer = reductionPct(best.weightedExposure, fastestRoute.weightedExposure);
    const lowerPred = reductionPct(best.predictedRisk, fastestRoute.predictedRisk);
    const gains = [
      fewer > 0 ? `${fewer}% less severity-weighted incident exposure` : null,
      lowerPred > 0 ? `${lowerPred}% lower predicted risk` : null,
    ].filter(Boolean).join(' and ') || 'lower overall risk';
    const extraMin = Math.round((best.durationMin - fastestRoute.durationMin) * 10) / 10;
    const extraKm = Math.round((best.distanceKm - fastestRoute.distanceKm) * 10) / 10;
    summary = `Safer alternative: ${gains} than the fastest route, for ${extraMin >= 0 ? '+' : ''}${extraMin} min and ${extraKm >= 0 ? '+' : ''}${extraKm} km.`;
  }

  return {
    from, to, bufferM: BUFFER_M, summary,
    routes: scored.sort((a, b) => (b.recommended - a.recommended) || a.danger - b.danger),
    sources: { routing: process.env.OSRM_URL ? 'OSRM (self-hosted)' : 'OSRM public demo server', geocoding: 'OpenStreetMap Nominatim', incidents: pts.length },
    disclaimer: 'Based on reported historical incidents only; it does not account for live traffic, road works or weather. Always follow traffic rules.',
  };
}

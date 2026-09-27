/**
 * Emergency coverage ("ambulance desert") analysis.
 *
 * Groups historical accidents into ~1 km cells and computes the drive time
 * from the nearest emergency-capable hospital (and the nearest trauma centre)
 * to each cell, using OSRM in batches. Cells with many serious accidents and
 * long drive times are the places where the network is weakest.
 *
 * The result is cached on disk for a day because it uses the free public OSRM
 * server; POST /api/admin/coverage/refresh recomputes it.
 */
import fs from 'fs';
import path from 'path';
import { haversineKm } from '../ai/geo.mjs';
import { estimateDrive } from './routing.mjs';

const CELL_LAT = 0.009;   // ≈ 1 km
const CELL_LNG = 0.0092;  // ≈ 1 km at 13°N
const DAYTIME_TRAFFIC = 1.25; // applied to free-flow OSRM times; reported in the result
const TTL_MS = 24 * 3600 * 1000;
const SEV_WEIGHT = { fatal: 3, serious: 2, minor: 1 };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function accidentCells(accidents) {
  const cells = new Map();
  for (const a of accidents) {
    if (a.lat == null || a.lng == null) continue;
    const key = `${Math.floor((a.lat - 12.5) / CELL_LAT)}:${Math.floor((a.lng - 77) / CELL_LNG)}`;
    if (!cells.has(key)) cells.set(key, { key, sumLat: 0, sumLng: 0, accidents: 0, fatal: 0, serious: 0, minor: 0, weight: 0 });
    const c = cells.get(key);
    c.sumLat += a.lat; c.sumLng += a.lng; c.accidents++;
    if (c[a.severity] != null) c[a.severity]++;
    c.weight += SEV_WEIGHT[a.severity] || 1;
  }
  // Centroid of the accidents themselves (lies on the roads, unlike the cell centre).
  return [...cells.values()].map(({ sumLat, sumLng, ...c }) => ({ ...c, lat: sumLat / c.accidents, lng: sumLng / c.accidents }));
}

function nearest(hospitals, p, n) {
  return hospitals.map(h => ({ h, d: haversineKm(p.lat, p.lng, h.lat, h.lng) })).sort((a, b) => a.d - b.d).slice(0, n).map(x => x.h);
}

/** Split cells into OSRM-sized batches (cells + their candidate hospitals ≤ 95 coordinates). */
function batches(cells) {
  const sorted = cells.slice().sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const out = [];
  let cur = { cells: [], hospitals: new Map() };
  for (const c of sorted) {
    const extra = c.candidates.filter(h => !cur.hospitals.has(h.id)).length;
    if (cur.cells.length && (cur.cells.length + 1 + cur.hospitals.size + extra > 95 || cur.cells.length >= 30)) {
      out.push(cur);
      cur = { cells: [], hospitals: new Map() };
    }
    cur.cells.push(c);
    for (const h of c.candidates) cur.hospitals.set(h.id, h);
  }
  if (cur.cells.length) out.push(cur);
  return out;
}

export function summarize(cells) {
  const total = cells.reduce((s, c) => s + c.accidents, 0);
  const within = (key, max) => cells.filter(c => c[key] != null && c[key] <= max).reduce((s, c) => s + c.accidents, 0);
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : null);
  const band = (lo, hi) => pct(cells.filter(c => c.eta_min > lo && c.eta_min <= hi).reduce((s, c) => s + c.accidents, 0));
  return {
    cells: cells.length,
    accidents: total,
    within_10_min_pct: pct(within('eta_min', 10)),
    band_10_20_pct: band(10, 20),
    over_20_min_pct: band(20, Infinity),
    trauma_within_20_min_pct: pct(within('trauma_eta_min', 20)),
    trauma_within_30_min_pct: pct(within('trauma_eta_min', 30)),
    median_eta_min: r1(cells.map(c => c.eta_min).sort((a, b) => a - b)[Math.floor(cells.length / 2)] ?? null),
  };
}

/** Accident-weighted underserved cells: weight × minutes beyond a 10-minute response. */
export function deserts(cells, n = 10) {
  return cells.map(c => ({ ...c, desert_score: r1(c.weight * Math.max(0, (c.eta_min ?? 0) - 10)) }))
    .filter(c => c.desert_score > 0)
    .sort((a, b) => b.desert_score - a.desert_score)
    .slice(0, n);
}

export function createCoverageService({ getAccidents, store, router, cacheFile = null, logger = console, now = () => new Date(), throttleMs = 1100 }) {
  let cached = null;
  let computing = null;
  let progress = null;

  if (cacheFile && fs.existsSync(cacheFile)) {
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cached = null; }
  }

  async function compute() {
    const [accidents, hospitals] = await Promise.all([getAccidents(), store.listDispatchableHospitals()]);
    const all = hospitals.filter(h => h.lat != null);
    const trauma = all.filter(h => h.emergency_level === 'trauma');
    const cells = accidentCells(accidents).map(c => {
      const near = nearest(all, c, 3);
      const nearTrauma = nearest(trauma, c, 2);
      const ids = new Set(near.map(h => h.id));
      return { ...c, candidates: [...near, ...nearTrauma.filter(h => !ids.has(h.id))] };
    });

    const groups = batches(cells);
    let osrmBatches = 0;
    progress = { done: 0, total: groups.length };
    for (const g of groups) {
      const hs = [...g.hospitals.values()];
      let matrix = null;
      try {
        matrix = await router.matrix(hs, g.cells);
        osrmBatches++;
      } catch (e) {
        logger.warn?.('[emergency] coverage OSRM batch failed, using estimates:', e.message);
      }
      g.cells.forEach((c, j) => {
        const times = c.candidates.map(h => {
          const i = hs.findIndex(x => x.id === h.id);
          const osrm = matrix?.[i]?.[j];
          return osrm != null
            ? { h, min: osrm * DAYTIME_TRAFFIC, source: 'osrm' }
            : { h, min: estimateDrive(h, c).durationMin * DAYTIME_TRAFFIC, source: 'estimate' };
        });
        const best = times.reduce((a, b) => (b.min < a.min ? b : a), times[0]);
        const bestTrauma = times.filter(x => x.h.emergency_level === 'trauma').reduce((a, b) => (!a || b.min < a.min ? b : a), null);
        c.eta_min = best ? r1(best.min) : null;
        c.eta_source = best?.source || null;
        c.nearest = best ? { id: best.h.id, name: best.h.name, level: best.h.emergency_level } : null;
        c.trauma_eta_min = bestTrauma ? r1(bestTrauma.min) : null;
        c.trauma = bestTrauma ? { id: bestTrauma.h.id, name: bestTrauma.h.name } : null;
      });
      progress.done++;
      if (throttleMs) await new Promise(r => setTimeout(r, throttleMs));
    }

    const out = cells.map(({ candidates, key, ...c }) => ({ ...c, lat: r1(c.lat * 1e4) / 1e4, lng: r1(c.lng * 1e4) / 1e4 }));
    return {
      status: 'ready',
      computedAt: now().toISOString(),
      params: { cellKm: 1, trafficFactor: DAYTIME_TRAFFIC, routing: osrmBatches === groups.length ? 'osrm' : osrmBatches ? 'osrm+estimate' : 'estimate' },
      summary: summarize(out),
      deserts: deserts(out),
      cells: out,
      hospitals: all.map(h => ({ id: h.id, name: h.name, lat: h.lat, lng: h.lng, emergency_level: h.emergency_level })),
    };
  }

  function start() {
    if (!computing) {
      computing = compute()
        .then(result => {
          cached = result;
          if (cacheFile) {
            try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch (e) { logger.warn?.('[emergency] could not cache coverage:', e.message); }
          }
          return result;
        })
        .finally(() => { computing = null; progress = null; });
      computing.catch(e => logger.warn?.('[emergency] coverage computation failed:', e.message));
    }
    return computing;
  }

  return {
    /** Cached result (recomputed in the background when stale). */
    get({ refresh = false } = {}) {
      const stale = !cached || refresh || now() - new Date(cached.computedAt) > TTL_MS;
      if (stale) start();
      if (cached) return { ...cached, refreshing: !!computing };
      return { status: 'computing', progress };
    },
    compute: start,
  };
}

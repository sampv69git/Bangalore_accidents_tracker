/**
 * Drive-time estimates for dispatch.
 *
 * Uses OSRM (the same free public server as Safe Route; override with
 * OSRM_URL). OSRM has no live traffic, so durations are scaled by a
 * time-of-day factor for Bengaluru. If OSRM is slow or down, a straight-line
 * estimate is used instead and marked source='estimate' — dispatch never
 * waits more than a few seconds on routing.
 */
import { haversineKm } from '../ai/geo.mjs';

const UA = 'BangaloreAccidentsTracker/1.0 (student project)';
const OSRM_MAX_COORDS = 100; // public server --max-table-size
const ROAD_DETOUR = 1.35;    // road distance ÷ straight-line distance, typical for the city
const FALLBACK_KMH = 24;     // average urban speed used when OSRM is unavailable

/**
 * Multiplier applied to free-flow OSRM durations (IST hour of day). Rough
 * congestion allowance; set EMERGENCY_TRAFFIC_FACTOR to force a constant.
 */
export function trafficFactor(date = new Date()) {
  const forced = parseFloat(process.env.EMERGENCY_TRAFFIC_FACTOR || '');
  if (Number.isFinite(forced) && forced > 0) return forced;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' }).format(date));
  if ((hour >= 8 && hour < 11) || (hour >= 17 && hour < 21)) return 1.5;
  if (hour >= 11 && hour < 17) return 1.25;
  if (hour >= 22 || hour < 6) return 1.0;
  return 1.15;
}

export function estimateDrive(from, to) {
  const km = haversineKm(from.lat, from.lng, to.lat, to.lng) * ROAD_DETOUR;
  return { distanceKm: km, durationMin: (km / FALLBACK_KMH) * 60 };
}

const round1 = (x) => Math.round(x * 10) / 10;
const coord = (p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`;

export function createRouter({ fetchImpl = globalThis.fetch, baseUrl = process.env.OSRM_URL || 'https://router.project-osrm.org', timeoutMs = 6000, now = () => new Date(), disabled = process.env.EMERGENCY_DISABLE_OSRM === 'true', logger = console } = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  const cache = new Map();

  async function get(url, ttlMs) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.body;
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(body.message || body.code || 'OSRM error');
    cache.set(url, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return body;
  }

  const finish = (distanceKm, durationMin, source, factor) => ({
    distanceKm: round1(distanceKm),
    durationMin: round1(durationMin * factor),
    source,
  });

  /**
   * Drive time from each origin to one destination.
   * @returns {Promise<Array<{distanceKm:number, durationMin:number, source:'osrm'|'estimate'}>>}
   */
  async function toDestination(origins, dest) {
    const factor = trafficFactor(now());
    const fallback = origins.map(o => { const e = estimateDrive(o, dest); return finish(e.distanceKm, e.durationMin, 'estimate', factor); });
    if (disabled || !origins.length) return fallback;
    const out = fallback.slice();
    const chunk = OSRM_MAX_COORDS - 1;
    for (let i = 0; i < origins.length; i += chunk) {
      const part = origins.slice(i, i + chunk);
      try {
        const coords = [...part, dest].map(coord).join(';');
        const sources = part.map((_, k) => k).join(';');
        const body = await get(`${base}/table/v1/driving/${coords}?sources=${sources}&destinations=${part.length}&annotations=duration,distance`, 5 * 60 * 1000);
        part.forEach((_, k) => {
          const d = body.durations?.[k]?.[0], m = body.distances?.[k]?.[0];
          if (Number.isFinite(d) && Number.isFinite(m)) out[i + k] = finish(m / 1000, d / 60, 'osrm', factor);
        });
      } catch (e) {
        logger.warn?.('[emergency] OSRM table failed, using estimates:', e.message);
      }
    }
    return out;
  }

  /** Full route (for maps) with the same fallback; coordinates are [lng, lat] pairs. */
  async function route(from, to) {
    const factor = trafficFactor(now());
    if (!disabled) {
      try {
        const body = await get(`${base}/route/v1/driving/${coord(from)};${coord(to)}?overview=full&geometries=geojson&steps=false`, 60 * 1000);
        const r = body.routes?.[0];
        if (r) return { ...finish(r.distance / 1000, r.duration / 60, 'osrm', factor), coordinates: r.geometry.coordinates };
      } catch (e) {
        logger.warn?.('[emergency] OSRM route failed, using estimate:', e.message);
      }
    }
    const e = estimateDrive(from, to);
    return { ...finish(e.distanceKm, e.durationMin, 'estimate', factor), coordinates: [[from.lng, from.lat], [to.lng, to.lat]] };
  }

  /**
   * Many-to-many free-flow durations (minutes), for the coverage analysis.
   * Returns matrix[source][destination] (null where unroutable). Throws on failure.
   */
  async function matrix(sources, destinations) {
    if (disabled) throw new Error('OSRM disabled');
    if (sources.length + destinations.length > OSRM_MAX_COORDS) throw new Error('too many coordinates for one OSRM table request');
    const coords = [...sources, ...destinations].map(coord).join(';');
    const src = sources.map((_, k) => k).join(';');
    const dst = destinations.map((_, k) => sources.length + k).join(';');
    const body = await get(`${base}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration`, 24 * 3600 * 1000);
    return body.durations.map(row => row.map(d => (Number.isFinite(d) ? d / 60 : null)));
  }

  return { toDestination, route, matrix, trafficFactor: () => trafficFactor(now()) };
}

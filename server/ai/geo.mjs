/** Small geometry helpers shared by the risk model, safe-route scoring and integrity checks. */

export const BLR_CENTER = { lat: 12.9716, lng: 77.5946 };

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const haversineM = (lat1, lon1, lat2, lon2) => haversineKm(lat1, lon1, lat2, lon2) * 1000;

/** Local equirectangular projection to metres (accurate at city scale). */
export function toXY(lat, lng, refLat = BLR_CENTER.lat) {
  const kx = 111320 * Math.cos(refLat * Math.PI / 180);
  return { x: lng * kx, y: lat * 110574 };
}

/** Distance in metres from point P to segment AB (all {lat,lng}). */
export function pointToSegmentM(p, a, b) {
  const P = toXY(p.lat, p.lng), A = toXY(a.lat, a.lng), B = toXY(b.lat, b.lng);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

/** Length of a [lng,lat] polyline in km. */
export function polylineKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return km;
}

/** Resample a [lng,lat] polyline to {lat,lng} points roughly every `stepM` metres. */
export function densify(coords, stepM = 40) {
  if (!coords.length) return [];
  const out = [{ lat: coords[0][1], lng: coords[0][0] }];
  for (let i = 1; i < coords.length; i++) {
    const [lng0, lat0] = coords[i - 1];
    const [lng1, lat1] = coords[i];
    const d = haversineM(lat0, lng0, lat1, lng1);
    const n = Math.max(1, Math.ceil(d / stepM));
    for (let k = 1; k <= n; k++) out.push({ lat: lat0 + (lat1 - lat0) * k / n, lng: lng0 + (lng1 - lng0) * k / n });
  }
  return out;
}

/** Uniform lat/lng grid (~500 m cells at Bangalore's latitude). */
export const GRID = { lat0: 12.5, lng0: 77.0, dLat: 0.0045, dLng: 0.0046 };

export function cellOf(lat, lng, g = GRID) {
  return { i: Math.floor((lat - g.lat0) / g.dLat), j: Math.floor((lng - g.lng0) / g.dLng) };
}

export const cellKey = (i, j) => `${i}:${j}`;

export function cellCenter(i, j, g = GRID) {
  return { lat: g.lat0 + (i + 0.5) * g.dLat, lng: g.lng0 + (j + 0.5) * g.dLng };
}

export function cellPolygon(i, j, g = GRID) {
  const s = g.lat0 + i * g.dLat, w = g.lng0 + j * g.dLng;
  const n = s + g.dLat, e = w + g.dLng;
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return [[[r(w), r(s)], [r(e), r(s)], [r(e), r(n)], [r(w), r(n)], [r(w), r(s)]]];
}

/** Simple spatial hash for fast "points near here" lookups. */
export class PointIndex {
  constructor(points, bucketDeg = 0.002) {
    this.b = bucketDeg;
    this.map = new Map();
    for (const p of points) {
      const k = this.key(p.lat, p.lng);
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(p);
    }
  }
  key(lat, lng) { return `${Math.floor(lat / this.b)}:${Math.floor(lng / this.b)}`; }
  near(lat, lng, radiusM) {
    const r = Math.ceil((radiusM / 107000) / this.b) + 1;
    const bi = Math.floor(lat / this.b), bj = Math.floor(lng / this.b);
    const out = [];
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        const list = this.map.get(`${bi + di}:${bj + dj}`);
        if (!list) continue;
        for (const p of list) if (haversineM(lat, lng, p.lat, p.lng) <= radiusM) out.push(p);
      }
    }
    return out;
  }
}

/** Seeded PRNG (mulberry32) so model evaluation is reproducible. */
export function seededRandom(seed = 42) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

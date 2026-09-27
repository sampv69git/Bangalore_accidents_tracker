/**
 * Risk hotspot prediction — Poisson GLM on a ~500 m grid.
 *
 * Question the model answers: "given the incidents we already know about,
 * where are the NEXT incidents most likely to be reported?"
 *
 * Training setup (leakage-free):
 *  1. Shuffle incidents into K folds.
 *  2. For fold k, features are computed from the other folds ("history") and
 *     the target is the number of fold-k incidents ("unseen") in each cell.
 *  3. A Poisson regression  log E[y] = β·x  is fitted with Newton-Raphson + L2.
 *  Cross-validation fits on K-1 folds' rows and scores the held-out fold, and is
 *  compared with the naive baseline "rank cells by past incident count".
 *
 * Metrics: hit rate @ top-5/10% of cells, Predictive Accuracy Index (PAI =
 * hit rate / area share, standard for hotspot forecasting), Poisson deviance
 * pseudo-R².
 *
 * Features per cell (all from history only):
 *   log1p(own count), log1p(ring-1 count), log1p(ring-2 count),
 *   fatal share nearby (smoothed), major-road share nearby (NH/flyover/ORR keywords),
 *   distance to city centre.
 */
import { GRID, cellOf, cellKey, cellCenter, cellPolygon, haversineKm, BLR_CENTER, PointIndex, seededRandom } from './geo.mjs';

export const ROAD_RE = /highway|\bnh\b|nh[-\s]?\d|flyover|outer ring|\borr\b|expressway|elevated|bypass|toll|ring road/i;

export const FEATURE_NAMES = ['intercept', 'log_own', 'log_ring1', 'log_ring2', 'fatal_share', 'major_road_share', 'dist_centre_10km'];

function countCells(points) {
  const m = new Map();
  for (const p of points) {
    const { i, j } = cellOf(p.lat, p.lng);
    const k = cellKey(i, j);
    let c = m.get(k);
    if (!c) { c = { i, j, n: 0, fatal: 0, road: 0 }; m.set(k, c); }
    c.n++;
    if (p.severity === 'fatal') c.fatal++;
    if (ROAD_RE.test(`${p.title} ${p.location} ${p.area}`)) c.road++;
  }
  return m;
}

function ring(counts, i, j, r, field = 'n') {
  let s = 0;
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const c = counts.get(cellKey(i + di, j + dj));
      if (c) s += c[field];
    }
  }
  return s;
}

export function cellFeatures(counts, i, j) {
  const own = counts.get(cellKey(i, j));
  const n0 = own?.n || 0;
  const r1 = ring(counts, i, j, 1);
  const r2 = ring(counts, i, j, 2);
  const local = n0 + r1;
  const fatalLocal = (own?.fatal || 0) + ring(counts, i, j, 1, 'fatal');
  const roadLocal = (own?.road || 0) + ring(counts, i, j, 1, 'road');
  const c = cellCenter(i, j);
  return [
    1,
    Math.log1p(n0),
    Math.log1p(r1),
    Math.log1p(r2),
    (fatalLocal + 0.3) / (local + 1),
    (roadLocal + 0.1) / (local + 1),
    haversineKm(c.lat, c.lng, BLR_CENTER.lat, BLR_CENTER.lng) / 10,
  ];
}

/** Cells within Chebyshev distance `pad` of any incident. */
function candidateCells(points, pad = 2) {
  const set = new Map();
  for (const p of points) {
    const { i, j } = cellOf(p.lat, p.lng);
    for (let di = -pad; di <= pad; di++) {
      for (let dj = -pad; dj <= pad; dj++) set.set(cellKey(i + di, j + dj), { i: i + di, j: j + dj });
    }
  }
  return [...set.values()];
}

// ── Poisson GLM (Newton-Raphson with L2) ────────────────────────────────────

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, r) => [...row, b[r]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, r) => row[n] / (row[r] || 1e-12));
}

export function fitPoisson(X, y, { lambda = 1, iters = 30 } = {}) {
  const p = X[0].length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let beta = new Array(p).fill(0);
  beta[0] = Math.log(meanY + 1e-6);
  for (let it = 0; it < iters; it++) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let r = 0; r < X.length; r++) {
      const x = X[r];
      let eta = 0;
      for (let k = 0; k < p; k++) eta += beta[k] * x[k];
      const mu = Math.exp(Math.min(20, eta));
      const resid = y[r] - mu;
      for (let a = 0; a < p; a++) {
        g[a] += x[a] * resid;
        for (let b = a; b < p; b++) H[a][b] += mu * x[a] * x[b];
      }
    }
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < a; b++) H[a][b] = H[b][a];
      if (a > 0) { g[a] -= lambda * beta[a]; H[a][a] += lambda; }
    }
    const step = solve(H, g);
    const maxStep = Math.max(...step.map(Math.abs));
    const damp = maxStep > 2 ? 2 / maxStep : 1; // damped Newton keeps early iterations stable
    beta = beta.map((v, k) => v + damp * step[k]);
    if (maxStep < 1e-6) break;
  }
  return beta;
}

export const predictMu = (beta, x) => Math.exp(Math.min(20, beta.reduce((s, b, k) => s + b * x[k], 0)));

function poissonDeviance(y, mu) {
  let d = 0;
  for (let i = 0; i < y.length; i++) {
    const m = Math.max(mu[i], 1e-9);
    d += (y[i] > 0 ? y[i] * Math.log(y[i] / m) : 0) - (y[i] - m);
  }
  return 2 * d;
}

/** Share of target incidents captured by the top `frac` of cells when ranked by `score`. */
export function hitRate(scores, y, frac) {
  const total = y.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const k = Math.max(1, Math.ceil(frac * scores.length));
  let hit = 0;
  for (let t = 0; t < k; t++) hit += y[idx[t]];
  return hit / total;
}

function percentileRanks(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  let t = 0;
  while (t < idx.length) {
    let u = t;
    while (u + 1 < idx.length && values[idx[u + 1]] === values[idx[t]]) u++;
    const pct = values.length > 1 ? (((t + u) / 2) / (values.length - 1)) * 100 : 100;
    for (let k = t; k <= u; k++) ranks[idx[k]] = pct;
    t = u + 1;
  }
  return ranks;
}

export function levelFor(pct) {
  if (pct >= 95) return 'very_high';
  if (pct >= 85) return 'high';
  if (pct >= 65) return 'medium';
  return 'low';
}

// ── Training ────────────────────────────────────────────────────────────────

const GENERIC_NAMES = /^(the road|road|main road|bengaluru|bangalore|unknown|city|highway)$/i;

/** Build K-fold rows: features from the other folds (history), target from this fold (unseen). */
function buildFoldRows(pts, cands, folds, rand) {
  const order = pts.map(p => ({ p, r: rand() })).sort((a, b) => a.r - b.r).map(o => o.p);
  const foldOf = new Map(order.map((p, i) => [p, i % folds]));
  const rows = [];
  for (let k = 0; k < folds; k++) {
    const hist = countCells(pts.filter(p => foldOf.get(p) !== k));
    const target = countCells(pts.filter(p => foldOf.get(p) === k));
    const X = [], y = [], base = [];
    for (const c of cands) {
      X.push(cellFeatures(hist, c.i, c.j));
      y.push(target.get(cellKey(c.i, c.j))?.n || 0);
      base.push((hist.get(cellKey(c.i, c.j))?.n || 0) + 0.001 * ring(hist, c.i, c.j, 1));
    }
    rows.push({ X, y, base });
  }
  return rows;
}

/**
 * Temporal backtest: incidents dated in the most recent quarter of the dated
 * record are the test set; everything older (plus undated) is history.
 * This is the honest "can we forecast future incidents" check.
 */
function temporalBacktest(pts, cands, folds, rand, lambda) {
  const dated = pts.filter(p => p.date).sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length < 40) return null;
  const cutoff = dated[Math.floor(dated.length * 0.75)].date;
  const test = pts.filter(p => p.date && p.date >= cutoff);
  const history = pts.filter(p => !(p.date && p.date >= cutoff));
  if (test.length < 10 || history.length < 20) return null;
  const rows = buildFoldRows(history, cands, folds, rand);
  const beta = fitPoisson(rows.flatMap(r => r.X), rows.flatMap(r => r.y), { lambda });
  const hist = countCells(history);
  const target = countCells(test);
  const mu = [], base = [], y = [];
  for (const c of cands) {
    mu.push(predictMu(beta, cellFeatures(hist, c.i, c.j)));
    base.push((hist.get(cellKey(c.i, c.j))?.n || 0) + 0.001 * ring(hist, c.i, c.j, 1));
    y.push(target.get(cellKey(c.i, c.j))?.n || 0);
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    cutoffDate: cutoff, testIncidents: test.length, historyIncidents: history.length,
    model: { hit5: r3(hitRate(mu, y, 0.05)), hit10: r3(hitRate(mu, y, 0.10)) },
    baseline: { hit5: r3(hitRate(base, y, 0.05)), hit10: r3(hitRate(base, y, 0.10)) },
  };
}

export function trainRiskModel(records, { folds = 5, seed = 42, lambda = null } = {}) {
  const pts = records.filter(r => r.lat != null && r.lng != null);
  if (pts.length < 20) throw new Error(`Need at least 20 geocoded incidents to train (have ${pts.length})`);

  const rand = seededRandom(seed);
  const cands = candidateCells(pts);
  const foldRows = buildFoldRows(pts, cands, folds, rand);
  // Incidents are often geocoded to shared area centroids, which makes the
  // unregularised MLE diverge (quasi-separation); ridge strength scales with data size.
  const lam = lambda ?? Math.max(50, 0.01 * cands.length * folds);

  // Cross-validation.
  const cv = { model: { hit5: 0, hit10: 0, pai5: 0, pai10: 0, pseudoR2: 0 }, baseline: { hit5: 0, hit10: 0, pai5: 0, pai10: 0 } };
  for (let k = 0; k < folds; k++) {
    const trX = [], trY = [];
    foldRows.forEach((f, idx) => { if (idx !== k) { trX.push(...f.X); trY.push(...f.y); } });
    const beta = fitPoisson(trX, trY, { lambda: lam });
    const te = foldRows[k];
    const mu = te.X.map(x => predictMu(beta, x));
    const meanTr = trY.reduce((a, b) => a + b, 0) / trY.length;
    const dev = poissonDeviance(te.y, mu);
    const devNull = poissonDeviance(te.y, te.y.map(() => meanTr));
    const h5 = hitRate(mu, te.y, 0.05), h10 = hitRate(mu, te.y, 0.10);
    const b5 = hitRate(te.base, te.y, 0.05), b10 = hitRate(te.base, te.y, 0.10);
    cv.model.hit5 += h5 / folds; cv.model.hit10 += h10 / folds;
    cv.model.pai5 += (h5 / 0.05) / folds; cv.model.pai10 += (h10 / 0.10) / folds;
    cv.model.pseudoR2 += (devNull > 0 ? 1 - dev / devNull : 0) / folds;
    cv.baseline.hit5 += b5 / folds; cv.baseline.hit10 += b10 / folds;
    cv.baseline.pai5 += (b5 / 0.05) / folds; cv.baseline.pai10 += (b10 / 0.10) / folds;
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  cv.model = round(cv.model);
  cv.baseline = round(cv.baseline);

  // Final model on all fold rows; serve with all incidents as history.
  const allX = foldRows.flatMap(f => f.X), allY = foldRows.flatMap(f => f.y);
  const beta = fitPoisson(allX, allY, { lambda: lam });
  const backtest = temporalBacktest(pts, cands, folds, seededRandom(seed + 1), lam);

  const counts = countCells(pts);
  const index = new PointIndex(pts, 0.01);
  const mus = cands.map(c => predictMu(beta, cellFeatures(counts, c.i, c.j)));
  const pcts = percentileRanks(mus);
  // Relative risk is expressed against the average cell that has had incidents
  // (dividing by every empty cell would give meaningless 200x multiples).
  const active = cands.map((c, idx) => (counts.get(cellKey(c.i, c.j)) ? mus[idx] : null)).filter(v => v != null);
  const meanMu = active.reduce((a, b) => a + b, 0) / Math.max(1, active.length);

  const cells = cands.map((c, idx) => {
    const own = counts.get(cellKey(c.i, c.j));
    const x = cellFeatures(counts, c.i, c.j);
    const center = cellCenter(c.i, c.j);
    return {
      key: cellKey(c.i, c.j), i: c.i, j: c.j, lat: center.lat, lng: center.lng,
      expected: Math.round(mus[idx] * 1000) / 1000,
      relativeRisk: Math.round((mus[idx] / meanMu) * 100) / 100,
      riskIndex: Math.round(pcts[idx]),
      level: levelFor(pcts[idx]),
      pastIncidents: own?.n || 0,
      pastFatal: own?.fatal || 0,
      fatalShare: Math.round(x[4] * 100) / 100,
      majorRoadShare: Math.round(x[5] * 100) / 100,
    };
  });

  // Name the higher-risk cells after the most common location among nearby incidents.
  for (const cell of cells) {
    if (cell.level === 'low') continue;
    const near = index.near(cell.lat, cell.lng, 700);
    const tally = new Map();
    for (const p of near) {
      let name = (p.location || '').trim();
      if (!name || GENERIC_NAMES.test(name) || name.length > 60) name = (p.area || '').trim();
      if (name && !GENERIC_NAMES.test(name) && name.length <= 60) tally.set(name, (tally.get(name) || 0) + 1);
    }
    cell.name = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    cell.area = near[0]?.area || null;
    cell.zone = near[0]?.zone || null;
  }

  // Hour-of-day multiplier, only if enough incidents carry a time.
  const withHour = pts.filter(p => p.hour != null);
  let hourProfile = null;
  if (withHour.length >= 30 && withHour.length / pts.length >= 0.15) {
    const h = new Array(24).fill(1);
    withHour.forEach(p => h[p.hour]++);
    const tot = h.reduce((a, b) => a + b, 0);
    hourProfile = h.map(v => Math.round((v / tot) * 24 * 100) / 100);
  }

  const cellMap = new Map(cells.map(c => [c.key, c]));
  return {
    trainedAt: new Date().toISOString(),
    nIncidents: pts.length,
    nCells: cells.length,
    cellSizeM: 500,
    folds,
    coefficients: Object.fromEntries(FEATURE_NAMES.map((n, k) => [n, Math.round(beta[k] * 1000) / 1000])),
    beta,
    uniqueLocations: new Set(pts.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)).size,
    lambda: lam,
    metrics: {
      crossValidation: cv,
      temporalBacktest: backtest,
      liftOverBaselineTop10: cv.baseline.hit10 > 0 ? Math.round((cv.model.hit10 / cv.baseline.hit10) * 100) / 100 : null,
      explanation: `Cross-validated on held-out incidents, the top 10% of cells ranked by the model captured ${Math.round(cv.model.hit10 * 100)}% of them (PAI ${cv.model.pai10.toFixed(2)}) vs ${Math.round(cv.baseline.hit10 * 100)}% for ranking by past counts alone.` +
        (backtest ? ` Forecasting the ${backtest.testIncidents} most recent incidents (from ${backtest.cutoffDate}) using only older data: model top-10% captured ${Math.round(backtest.model.hit10 * 100)}% vs baseline ${Math.round(backtest.baseline.hit10 * 100)}%.` : ''),
    },
    timeCoverage: { withHour: withHour.length, total: pts.length },
    hourProfile,
    cells,
    cellMap,
  };
}

// ── Serving helpers ─────────────────────────────────────────────────────────

const LEVEL_ORDER = { low: 0, medium: 1, high: 2, very_high: 3 };

export function riskGeoJSON(model, { minLevel = 'medium', hour = null } = {}) {
  const min = LEVEL_ORDER[minLevel] ?? 1;
  const mult = hour != null && model.hourProfile ? model.hourProfile[hour] ?? 1 : 1;
  return {
    type: 'FeatureCollection',
    features: model.cells
      .filter(c => LEVEL_ORDER[c.level] >= min)
      .map(c => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: cellPolygon(c.i, c.j) },
        properties: {
          key: c.key, level: c.level, riskIndex: c.riskIndex,
          relativeRisk: Math.round(c.relativeRisk * mult * 100) / 100,
          expected: c.expected, pastIncidents: c.pastIncidents, pastFatal: c.pastFatal,
          fatalShare: c.fatalShare, name: c.name || null, area: c.area || null,
        },
      })),
  };
}

export function riskAt(model, lat, lng) {
  const { i, j } = cellOf(lat, lng);
  const c = model.cellMap.get(cellKey(i, j));
  if (c) return c;
  return { key: cellKey(i, j), lat, lng, level: 'low', riskIndex: 0, relativeRisk: 0, expected: 0, pastIncidents: 0, name: null };
}

export function topRiskCells(model, { limit = 10, area = null, zone = null } = {}) {
  let cells = model.cells.filter(c => c.level !== 'low');
  if (area) {
    const a = area.toLowerCase();
    cells = cells.filter(c => `${c.name || ''} ${c.area || ''}`.toLowerCase().includes(a));
  }
  if (zone) cells = cells.filter(c => (c.zone || '').toLowerCase() === zone.toLowerCase());
  return cells.sort((a, b) => b.expected - a.expected).slice(0, limit);
}

/** Public, JSON-safe summary of a model (drops the internal lookup map). */
export function modelSummary(model) {
  const { cellMap, cells, beta, ...rest } = model;
  const levels = cells.reduce((acc, c) => { acc[c.level] = (acc[c.level] || 0) + 1; return acc; }, {});
  return { ...rest, levels };
}

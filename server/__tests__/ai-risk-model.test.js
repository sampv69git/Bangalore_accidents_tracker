import { describe, it, expect } from 'vitest';
import { fitPoisson, predictMu, hitRate, trainRiskModel, riskAt, riskGeoJSON, topRiskCells, modelSummary } from '../ai/risk-model.mjs';
import { seededRandom } from '../ai/geo.mjs';
import { syntheticCity } from './fixtures/ai-fixtures.js';

function poissonSample(lambda, rand) {
  // Knuth's method (fine for small lambda)
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

describe('fitPoisson', () => {
  it('recovers known coefficients from simulated Poisson data', () => {
    const rand = seededRandom(3);
    const X = [], y = [];
    for (let i = 0; i < 4000; i++) {
      const x1 = rand() * 2;
      X.push([1, x1]);
      y.push(poissonSample(Math.exp(-0.5 + 0.9 * x1), rand));
    }
    const beta = fitPoisson(X, y, { lambda: 0.001 });
    expect(beta[0]).toBeCloseTo(-0.5, 1);
    expect(beta[1]).toBeCloseTo(0.9, 1);
    expect(predictMu(beta, [1, 1])).toBeGreaterThan(predictMu(beta, [1, 0]));
  });

  it('stays finite under quasi-separation (stacked data) thanks to ridge + damping', () => {
    const X = [], y = [];
    for (let i = 0; i < 500; i++) { const own = i % 10 === 0 ? 3 : 0; X.push([1, Math.log1p(own)]); y.push(own ? 2 : 0); }
    const beta = fitPoisson(X, y, { lambda: 50 });
    expect(beta.every(Number.isFinite)).toBe(true);
    expect(Math.abs(beta[1])).toBeLessThan(10);
  });
});

describe('hitRate', () => {
  it('measures the share of targets captured by the top cells', () => {
    expect(hitRate([5, 1, 0, 0], [3, 1, 0, 0], 0.25)).toBeCloseTo(0.75);
    expect(hitRate([0, 0, 1, 5], [3, 1, 0, 0], 0.25)).toBe(0);
  });
});

describe('trainRiskModel', () => {
  const recs = syntheticCity();
  const model = trainRiskModel(recs);

  it('ranks the densest cluster as the highest-risk area', () => {
    const top = topRiskCells(model, { limit: 1 })[0];
    expect(top.name).toMatch(/Silk Board/);
    expect(riskAt(model, 12.917, 77.623).level).toBe('very_high');
    expect(riskAt(model, 12.60, 77.10).level).toBe('low');
  });

  it('reports cross-validation metrics and a baseline comparison', () => {
    const cv = model.metrics.crossValidation;
    expect(cv.model.hit10).toBeGreaterThan(0.5);
    expect(cv.model.pai10).toBeGreaterThan(1);
    expect(cv.baseline.hit10).toBeGreaterThan(0);
    expect(model.metrics.explanation).toMatch(/held-out/);
  });

  it('serves a GeoJSON grid and a JSON-safe summary', () => {
    const fc = riskGeoJSON(model, { minLevel: 'high' });
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features[0].geometry.type).toBe('Polygon');
    expect(['high', 'very_high']).toContain(fc.features[0].properties.level);
    const summary = modelSummary(model);
    expect(summary.cellMap).toBeUndefined();
    expect(summary.levels.very_high).toBeGreaterThan(0);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('refuses to train on too little data', () => {
    expect(() => trainRiskModel(recs.slice(0, 5))).toThrow(/at least 20/);
  });
});

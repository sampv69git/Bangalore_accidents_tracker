/**
 * HTTP-level tests for the AI routes, using the real createAiFeatures wiring
 * with a temporary JSON dataset (no database, no network, no LLM).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { createAiFeatures } from '../ai/index.mjs';
import { syntheticCity } from './fixtures/ai-fixtures.js';

let app, ai, tmp;

beforeAll(() => {
  process.env.AI_DISABLE_LLM = 'true';
  process.env.AI_DISABLE_LOCAL_MODELS = 'true';
  process.env.AI_PREWARM = 'false';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-ai-'));
  const rows = syntheticCity().map(r => ({ ...r, hasCoords: true }));
  rows.push({ id: 'pending-1', title: 'User Report: Silk Board', location: 'Silk Board Junction', area: 'Silk Board', severity: 'minor', status: 'pending', description: 'sfdghmsdfgsdfgsdfgsdfg', lat: 12.917, lng: 77.623, hasCoords: true, date: '2026-09-20', reporter_id: 'u1' });
  const jsonPath = path.join(tmp, 'accidents.json');
  fs.writeFileSync(jsonPath, JSON.stringify(rows));

  ai = createAiFeatures({ jsonPath, cacheDir: path.join(tmp, 'cache'), logger: { log() {}, warn() {} } });
  app = express();
  app.use(express.json());
  app.use(ai.invalidateOnWrite);
  const validateJwt = (req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ error: 'missing authentication credentials' }));
  const requireAdmin = (req, res, next) => (req.headers.authorization === 'Bearer admin' ? next() : res.status(403).json({ error: 'insufficient permissions' }));
  ai.registerRoutes(app, { validateJwt, adminAuth: [validateJwt, requireAdmin] });
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('public AI routes', () => {
  it('POST /api/ask answers with the rule planner when the LLM is disabled', async () => {
    const res = await request(app).post('/api/ask').send({ question: 'Which areas have the most fatal accidents?' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('rules');
    expect(res.body.answer).toMatch(/Silk Board/);
    expect(res.body.chart).toBeTruthy();
  });

  it('POST /api/ask validates input', async () => {
    const res = await request(app).post('/api/ask').send({ question: '' });
    expect(res.status).toBe(400);
  });

  it('GET /api/risk/grid returns GeoJSON plus the model card', async () => {
    const res = await request(app).get('/api/risk/grid?minLevel=high');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('FeatureCollection');
    expect(res.body.features.length).toBeGreaterThan(0);
    expect(res.body.model.metrics.crossValidation).toBeTruthy();
    expect(res.body.model.nIncidents).toBe(125);
  });

  it('GET /api/risk/point validates coordinates', async () => {
    expect((await request(app).get('/api/risk/point?lat=x')).status).toBe(400);
    const ok = await request(app).get('/api/risk/point?lat=12.917&lng=77.623');
    expect(ok.body.level).toBe('very_high');
  });

  it('GET /api/digest returns a template digest offline', async () => {
    const res = await request(app).get('/api/digest?period=month');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('template');
    expect(res.body.facts.period.requested).toBe('month');
  });

  it('GET /api/routes/safe requires both endpoints', async () => {
    expect((await request(app).get('/api/routes/safe?from=Hebbal')).status).toBe(400);
  });

  it('GET /api/ai/status reports free-model configuration', async () => {
    const res = await request(app).get('/api/ai/status');
    expect(res.body.llm.available).toBe(false);
    expect(res.body.llm.textModels.every(m => m === 'openrouter/free' || m.endsWith(':free'))).toBe(true);
  });
});

describe('admin integrity routes', () => {
  it('require authentication and the admin role', async () => {
    expect((await request(app).get('/api/admin/integrity?ids=pending-1')).status).toBe(401);
    expect((await request(app).get('/api/admin/integrity?ids=pending-1').set('Authorization', 'Bearer user')).status).toBe(403);
  });

  it('run and cache the check for a pending report', async () => {
    const res = await request(app).get('/api/admin/integrity/pending-1').set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.overall.verdict).toBe('likely_fake_or_spam');
    expect(res.body.text.signals.map(s => s.code)).toContain('GIBBERISH');
    const sum = await request(app).get('/api/admin/integrity?ids=pending-1,unknown').set('Authorization', 'Bearer admin');
    expect(sum.body['pending-1'].verdict).toBe('likely_fake_or_spam');
    expect(sum.body.unknown).toBeNull();
  });

  it('404s for an unknown report', async () => {
    expect((await request(app).get('/api/admin/integrity/nope').set('Authorization', 'Bearer admin')).status).toBe(404);
  });

  it('analyse an uploaded image sent as a raw body', async () => {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 150 } } })
      .withExif({ IFD0: { Software: 'Midjourney v7' } }).jpeg().toBuffer();
    const res = await request(app).post('/api/admin/integrity/image-test').set('Authorization', 'Bearer admin').set('Content-Type', 'image/jpeg').send(img);
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('likely_fake');
    expect(res.body.signals.map(s => s.code)).toContain('AI_METADATA');
  });
});

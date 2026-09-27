/**
 * Wires BAT's AI features into the Express app.
 *
 *   POST /api/ask                         Ask BAT agent (natural-language analytics)
 *   GET  /api/risk/grid                   Predicted risk hotspots (GeoJSON grid)
 *   GET  /api/risk/model                  Model card: coefficients + validation metrics
 *   GET  /api/risk/point?lat=&lng=        Risk at a point
 *   GET  /api/routes/safe?from=&to=       Safer route suggestion (OSRM + incident scoring)
 *   GET  /api/digest?period=week|month    Grounded LLM digest
 *   GET  /api/ai/status                   Which free services/models are active
 *   Admin (JWT + admin role):
 *   GET  /api/admin/integrity?ids=a,b     Integrity verdicts for listed reports
 *   GET  /api/admin/integrity/:id         Full integrity report (runs the check if missing)
 *   POST /api/admin/integrity/:id/check   Re-run (optionally ?deep=1 for the vision-LLM check)
 *   POST /api/admin/integrity/image-test  Upload any image (raw body) to test the forensics
 *   POST /api/admin/risk/retrain          Retrain the risk model now
 *   POST /api/admin/digest/refresh        Regenerate the digest
 */
import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createDataset } from './dataset.mjs';
import { trainRiskModel, riskGeoJSON, riskAt, modelSummary } from './risk-model.mjs';
import { suggestSafeRoute, geocodePlace, parseLatLng } from './safe-route.mjs';
import { createDigestService } from './digest.mjs';
import { createIntegrityService } from './integrity.mjs';
import { askBat } from './ask-bat.mjs';
import { budgetStatus, llmAvailable, textModels, visionModels } from './llm.mjs';

export function createAiFeatures({ supabase = null, pool = null, jsonPath = null, cacheDir = null, logger = console } = {}) {
  const dataset = createDataset({ supabase, pool, jsonPath, logger });
  const digests = createDigestService({ dataset, cacheDir, logger });
  const integrity = createIntegrityService({ dataset, pool, supabase, cacheDir, logger });

  // Risk model: trained lazily, retrained when data changes (at most every 5 min) or every 6 h.
  let model = null, modelAt = 0, dirty = false, training = null;
  async function getModel({ force = false } = {}) {
    const stale = !model || force || Date.now() - modelAt > 6 * 3600 * 1000 || (dirty && Date.now() - modelAt > 5 * 60 * 1000);
    if (!stale) return model;
    if (!training) {
      training = dataset.active()
        .then(recs => { model = trainRiskModel(recs); modelAt = Date.now(); dirty = false; return model; })
        .catch(e => { logger.warn?.('[ai] risk model training failed:', e.message); if (!model) throw e; return model; })
        .finally(() => { training = null; });
    }
    return training;
  }

  function invalidate() { dataset.invalidate(); dirty = true; }

  /** Middleware: any successful write to the accident data refreshes the AI data cache. */
  function invalidateOnWrite(req, res, next) {
    // Emergency dispatch writes (including ambulance GPS pings every few seconds) don't touch accident records.
    if (req.method !== 'GET' && req.path.startsWith('/api/') && !/^\/api\/(ask|admin\/integrity|emergency|hospital|crew|admin\/(hospital|coverage|emergency))/.test(req.path)) {
      res.on('finish', () => { if (res.statusCode < 400) invalidate(); });
    }
    next();
  }

  /** Called after a citizen report is saved: run duplicate/spam/image checks in the background. */
  function onReportCreated(id) {
    invalidate();
    setTimeout(() => {
      integrity.check(id).then(r => logger.log?.(`[ai] integrity ${id}: ${r.overall.verdict} (${r.overall.score})`))
        .catch(e => logger.warn?.(`[ai] integrity check for ${id} failed:`, e.message));
    }, 250);
  }

  function registerRoutes(app, { validateJwt, adminAuth }) {
    const askLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many questions, please wait a few minutes.' } });
    const routeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many route requests, please wait a few minutes.' } });
    const readLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
    const fail = (res, e, code = 500) => res.status(code).json({ error: e.message || String(e) });

    app.get('/api/ai/status', readLimiter, async (_req, res) => {
      res.json({
        llm: { available: llmAvailable(), provider: 'OpenRouter (free models only)', textModels: textModels(), visionModels: visionModels(), budget: budgetStatus() },
        localModels: { textEmbeddings: process.env.AI_TEXT_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2', aiImageDetector: process.env.AI_IMAGE_DETECTOR_MODEL || 'onnx-community/SMOGY-Ai-images-detector-ONNX', disabled: process.env.AI_DISABLE_LOCAL_MODELS === 'true' },
        routing: process.env.OSRM_URL || 'https://router.project-osrm.org (public demo)',
        dataSources: dataset.sources(),
        riskModel: model ? { trainedAt: model.trainedAt, nIncidents: model.nIncidents } : null,
      });
    });

    app.post('/api/ask', askLimiter, async (req, res) => {
      try {
        const question = String(req.body?.question || '').trim();
        if (question.length < 3) return res.status(400).json({ error: 'Please type a question.' });
        const [records, m] = await Promise.all([dataset.all(), getModel().catch(() => null)]);
        res.json(await askBat(question, { records, model: m }));
      } catch (e) { fail(res, e); }
    });

    app.get('/api/risk/grid', readLimiter, async (req, res) => {
      try {
        const m = await getModel();
        const minLevel = ['low', 'medium', 'high', 'very_high'].includes(req.query.minLevel) ? req.query.minLevel : 'medium';
        const hour = req.query.hour != null && req.query.hour !== '' ? Math.max(0, Math.min(23, parseInt(req.query.hour, 10) || 0)) : null;
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ ...riskGeoJSON(m, { minLevel, hour }), model: modelSummary(m) });
      } catch (e) { fail(res, e); }
    });

    app.get('/api/risk/model', readLimiter, async (_req, res) => {
      try { res.json(modelSummary(await getModel())); } catch (e) { fail(res, e); }
    });

    app.get('/api/risk/point', readLimiter, async (req, res) => {
      const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng required' });
      try { res.json(riskAt(await getModel(), lat, lng)); } catch (e) { fail(res, e); }
    });

    app.get('/api/routes/safe', routeLimiter, async (req, res) => {
      try {
        const fromText = String(req.query.from || '').slice(0, 120), toText = String(req.query.to || '').slice(0, 120);
        if (!fromText || !toText) return res.status(400).json({ error: 'from and to are required (place name or "lat,lng")' });
        const [from, to] = [await geocodePlace(fromText), await geocodePlace(toText)];
        const [records, m] = await Promise.all([dataset.all(), getModel().catch(() => null)]);
        const out = await suggestSafeRoute({ from, to, records, model: m });
        res.json({ ...out, from: { ...from, query: fromText }, to: { ...to, query: toText } });
      } catch (e) {
        const userError = /Could not find|Empty place|inside the Bengaluru|too close|No route/i.test(e.message);
        fail(res, e, userError ? 400 : 502);
      }
    });

    app.get('/api/digest', readLimiter, async (req, res) => {
      try {
        const period = req.query.period === 'month' ? 'month' : 'week';
        res.json(await digests.get({ period }));
      } catch (e) { fail(res, e); }
    });

    // ── Admin ────────────────────────────────────────────────────────────────
    app.get('/api/admin/integrity', adminAuth, (req, res) => {
      const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
      res.json(integrity.summaries(ids));
    });

    app.get('/api/admin/integrity/:id', adminAuth, async (req, res) => {
      try {
        const cached = integrity.get(req.params.id);
        if (cached && req.query.refresh !== '1') return res.json(cached);
        res.json(await integrity.check(req.params.id, { deep: req.query.deep === '1' }));
      } catch (e) { fail(res, e, /not found/i.test(e.message) ? 404 : 500); }
    });

    app.post('/api/admin/integrity/:id/check', adminAuth, async (req, res) => {
      try { res.json(await integrity.check(req.params.id, { deep: req.query.deep === '1' || req.body?.deep === true })); }
      catch (e) { fail(res, e, /not found/i.test(e.message) ? 404 : 500); }
    });

    // Raw image body (Content-Type: image/*) so the global JSON parser is unaffected.
    app.post('/api/admin/integrity/image-test', adminAuth, express.raw({ type: 'image/*', limit: '10mb' }), async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send the image as the raw request body with an image/* Content-Type.' });
        const reported = {};
        if (req.query.lat && req.query.lng) { reported.lat = parseFloat(req.query.lat); reported.lng = parseFloat(req.query.lng); }
        if (req.query.date) reported.date = String(req.query.date).slice(0, 10);
        res.json(await integrity.analyzeUpload(req.body, { reported, deep: req.query.deep === '1' }));
      } catch (e) { fail(res, e, 400); }
    });

    app.post('/api/admin/risk/retrain', adminAuth, async (_req, res) => {
      try { dataset.invalidate(); res.json(modelSummary(await getModel({ force: true }))); } catch (e) { fail(res, e); }
    });

    app.post('/api/admin/digest/refresh', adminAuth, async (req, res) => {
      try { res.json(await digests.get({ period: req.query.period === 'month' ? 'month' : 'week', refresh: true })); } catch (e) { fail(res, e); }
    });
  }

  /** Warm caches after startup so the first user request is fast (model downloads happen once). */
  function prewarm() {
    if (process.env.AI_PREWARM === 'false') return;
    setTimeout(() => {
      getModel().then(m => logger.log?.(`[ai] risk model trained on ${m.nIncidents} incidents`)).catch(() => {});
      integrity.prewarm().then(() => logger.log?.('[ai] local integrity models ready')).catch(e => logger.warn?.('[ai] prewarm skipped:', e.message));
    }, 1500);
  }

  return { dataset, integrity, digests, getModel, invalidate, invalidateOnWrite, onReportCreated, registerRoutes, prewarm };
}

export { parseLatLng };
export const defaultCacheDir = (serverDir) => path.join(serverDir, '.cache');

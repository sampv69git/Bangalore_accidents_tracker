/**
 * Report integrity: semantic duplicate / spam detection + fake-image forensics.
 *
 * Everything here is free and runs locally by default:
 *  - Text embeddings: all-MiniLM-L6-v2 via transformers.js (ONNX, CPU). The
 *    model (~23 MB) downloads once from the Hugging Face hub and is cached.
 *    If the library is unavailable, a hashed TF-IDF fallback is used.
 *  - Image forensics: sharp (error level analysis, perceptual hash, format),
 *    exifr (camera/GPS/date/software metadata).
 *  - AI-generated image detector: onnx-community/SMOGY-Ai-images-detector-ONNX
 *    run locally via transformers.js.
 *  - Optional "deep" check: a free vision LLM on OpenRouter (admin-triggered only).
 *
 * All outputs are decision support for moderators, never automatic rejection.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { haversineM } from './geo.mjs';
import { chatJSON, visionModels, llmAvailable } from './llm.mjs';

const DEFAULT_TEXT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_IMAGE_DETECTOR = 'onnx-community/SMOGY-Ai-images-detector-ONNX';
// Bump when the checks change so cached results from older logic are recomputed.
export const INTEGRITY_VERSION = 3;

// Combine independent risk signals: P(any) = 1 - Π(1 - w_i).
export const noisyOr = (weights) => 1 - weights.reduce((p, w) => p * (1 - Math.max(0, Math.min(1, w))), 1);
const r2 = (x) => Math.round(x * 100) / 100;

// ── Local model loading (lazy, optional) ─────────────────────────────────────

let transformersPromise = null;
let modelCacheDir = null;
export function setModelCacheDir(dir) { modelCacheDir = dir; }

async function transformers() {
  if (process.env.AI_DISABLE_LOCAL_MODELS === 'true') return null;
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers')
      .then(mod => { if (modelCacheDir) mod.env.cacheDir = modelCacheDir; return mod; })
      .catch(e => { console.warn('[ai/integrity] transformers.js unavailable, using fallbacks:', e.message); return null; });
  }
  return transformersPromise;
}

const pipelines = new Map();
async function getPipeline(task, model) {
  const key = `${task}|${model}`;
  if (!pipelines.has(key)) {
    pipelines.set(key, (async () => {
      const mod = await transformers();
      if (!mod) return null;
      try { return await mod.pipeline(task, model, { dtype: 'fp32' }); }
      catch (e) { console.warn(`[ai/integrity] could not load ${model}:`, e.message); return null; }
    })());
  }
  return pipelines.get(key);
}

// ── Text embeddings ─────────────────────────────────────────────────────────

/** Deterministic fallback: hashed word + character-trigram TF vectors, L2-normalised. */
export function hashedVector(text, dim = 1024) {
  const v = new Float64Array(dim);
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9ಀ-೿ऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bump = (tok, w) => {
    const h = crypto.createHash('md5').update(tok).digest();
    v[h.readUInt32LE(0) % dim] += (h[4] & 1 ? 1 : -1) * w;
  };
  for (const w of s.split(' ')) if (w.length > 2) bump(`w:${w}`, 1);
  const padded = ` ${s} `;
  for (let i = 0; i + 3 <= padded.length; i++) bump(`c:${padded.slice(i, i + 3)}`, 0.5);
  const n = Math.hypot(...v) || 1;
  return Array.from(v, x => x / n);
}

export const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const embedCache = new Map();
/** Returns { vectors, method }. All vectors in one call share a method, so they are comparable. */
export async function embedTexts(texts, { forceFallback = false } = {}) {
  const model = process.env.AI_TEXT_EMBED_MODEL || DEFAULT_TEXT_MODEL;
  const ext = forceFallback ? null : await getPipeline('feature-extraction', model);
  if (!ext) return { vectors: texts.map(t => hashedVector(t)), method: 'hashed-tfidf' };
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    const k = crypto.createHash('sha1').update(t).digest('hex');
    if (embedCache.has(k)) out[i] = embedCache.get(k); else missing.push({ i, t, k });
  });
  if (missing.length) {
    const res = await ext(missing.map(m => m.t), { pooling: 'mean', normalize: true });
    const list = res.tolist();
    missing.forEach((m, idx) => {
      out[m.i] = list[idx];
      if (embedCache.size > 5000) embedCache.delete(embedCache.keys().next().value);
      embedCache.set(m.k, list[idx]);
    });
  }
  return { vectors: out, method: 'minilm-l6-v2' };
}

// ── Spam / relevance ────────────────────────────────────────────────────────

const ACCIDENT_WORDS = /accident|collid|collision|crash|hit\b|hit by|knock|overturn|skid|injur|dead|died|death|killed|bike|motorcycl|scooter|car\b|cab\b|bus\b|bmtc|ksrtc|truck|lorry|tipper|tanker|auto\b|autorickshaw|pedestrian|two[- ]wheeler|vehicle|rammed|run over|fell|flyover|junction|signal|ambulance|hospital|pothole|rider|driver|helmet|highway|road/i;
const PROMO_WORDS = /\b(buy|discount|offer|sale|cheap|click|subscribe|whats\s?app|telegram|loan|crypto|bitcoin|casino|betting|earn money|work from home|free gift|follow me|dm me|promo|coupon|investment|lottery|win cash|visit (?:our|my) (?:site|page))\b/i;

const ACCIDENT_PROTOTYPES = [
  'A bike rider was hit by a bus at the junction and was injured.',
  'Two cars collided on the flyover and the driver was taken to hospital.',
  'A truck overturned on the highway blocking traffic.',
  'A pedestrian was knocked down by a speeding car while crossing the road.',
  'An auto rickshaw rammed into a scooter near the signal.',
  'Road accident near the main road, vehicles damaged, ambulance called.',
];
const OFFTOPIC_PROTOTYPES = [
  'Buy cheap products online with a huge discount, click the link now.',
  'Hello, how are you? This is just a test message.',
  'Follow my page for daily updates and giveaways.',
  'The weather is nice today and I had lunch with friends.',
  'Earn money from home, message me on WhatsApp.',
];

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * Keyboard-mash detector for Latin-script text ("wdfgvhbjnk", "asdfghjkl").
 * Real English and romanised Kannada/Hindi words rarely have 5+ consonants in a
 * row or long runs of adjacent keyboard keys. Non-Latin scripts are skipped.
 */
export function gibberishScore(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  const letters = words.join('');
  if (letters.length < 12) return 0;
  let runChars = 0, keyHits = 0, trigrams = 0;
  for (const w of words) {
    for (const m of w.matchAll(/[^aeiouy]{5,}/g)) runChars += m[0].length;
    for (let i = 0; i + 3 <= w.length; i++) {
      trigrams++;
      const t = w.slice(i, i + 3);
      if (KEY_ROWS.some(row => row.includes(t))) keyHits++;
    }
  }
  const runFrac = runChars / letters.length;
  const keyFrac = trigrams ? keyHits / trigrams : 0;
  return Math.max(runFrac, keyFrac * 1.5);
}

/**
 * Letter-pair (bigram) model learned from the tracker's own incident titles and
 * locations, so Bengaluru place names ("Kadubeesanahalli", "Byatarayanapura")
 * count as normal. Keyboard mash is full of pairs that never occur in that text.
 * Measured on held-out real titles: max 4% rare pairs; keyboard mash: 15%+.
 */
const letterModels = new WeakMap();
export function buildLetterModel(texts) {
  const counts = new Map();
  let n = 0;
  for (const t of texts) {
    for (const w of String(t || '').toLowerCase().match(/[a-z]{2,}/g) || []) {
      const x = `^${w}$`;
      for (let i = 0; i + 2 <= x.length; i++) { const b = x.slice(i, i + 2); counts.set(b, (counts.get(b) || 0) + 1); n++; }
    }
  }
  return { counts, n };
}

export function rareBigramFraction(model, text) {
  if (!model || model.n < 2000) return 0;
  let n = 0, rare = 0;
  for (const w of String(text || '').toLowerCase().match(/[a-z]{2,}/g) || []) {
    const x = `^${w}$`;
    for (let i = 0; i + 2 <= x.length; i++) { n++; if ((model.counts.get(x.slice(i, i + 2)) || 0) < 3) rare++; }
  }
  return n >= 12 ? rare / n : 0;
}

function letterModelFor(records) {
  if (!letterModels.has(records)) letterModels.set(records, buildLetterModel(records.filter(r => r.status === 'active').map(r => `${r.title} ${r.location} ${r.area}`)));
  return letterModels.get(records);
}

export function heuristicSpamSignals(text, { letterModel = null } = {}) {
  const s = String(text || '');
  const signals = [];
  const words = s.toLowerCase().match(/[a-zಀ-೿ऀ-ॿ]+/g) || [];
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const caps = (s.match(/[A-Z]/g) || []).length;
  if (/https?:\/\/|www\.|\.(com|in|net|xyz|ly)\b/i.test(s)) signals.push({ code: 'LINK', weight: 0.35, message: 'Contains a web link' });
  if (/(?:\+91[\s-]?)?\b[6-9]\d{9}\b|[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) signals.push({ code: 'CONTACT_INFO', weight: 0.2, message: 'Contains a phone number or e-mail' });
  if (PROMO_WORDS.test(s)) signals.push({ code: 'PROMOTIONAL', weight: 0.35, message: 'Promotional / advertising language' });
  if (letters > 20 && caps / letters > 0.5) signals.push({ code: 'SHOUTING', weight: 0.1, message: 'Mostly upper-case text' });
  if (/(.)\1{5,}/.test(s)) signals.push({ code: 'REPEATED_CHARS', weight: 0.1, message: 'Long runs of repeated characters' });
  const nonSpace = s.replace(/\s/g, '').length;
  if (nonSpace > 15 && (s.match(/[\p{L}]/gu) || []).length / nonSpace < 0.6) signals.push({ code: 'LOW_TEXT_RATIO', weight: 0.15, message: 'Mostly symbols or digits' });
  if (words.length >= 10 && new Set(words).size / words.length < 0.35) signals.push({ code: 'REPETITIVE', weight: 0.15, message: 'Very repetitive wording' });
  const g = gibberishScore(s);
  const rareFrac = rareBigramFraction(letterModel, s);
  if (g >= 0.35 || rareFrac >= 0.12) signals.push({ code: 'GIBBERISH', weight: 0.65, message: 'Looks like random keyboard input, not a description', score: r2(Math.max(g, rareFrac)) });
  return signals;
}

async function relevanceSignal(text, method) {
  const hasKeyword = ACCIDENT_WORDS.test(text);
  if (method === 'hashed-tfidf') {
    return hasKeyword ? null : { code: 'OFF_TOPIC', weight: 0.35, message: 'Does not mention anything accident-related' };
  }
  const { vectors } = await embedTexts([text, ...ACCIDENT_PROTOTYPES, ...OFFTOPIC_PROTOTYPES]);
  const q = vectors[0];
  const acc = Math.max(...vectors.slice(1, 1 + ACCIDENT_PROTOTYPES.length).map(v => cosine(q, v)));
  const off = Math.max(...vectors.slice(1 + ACCIDENT_PROTOTYPES.length).map(v => cosine(q, v)));
  if (acc < 0.25 && !hasKeyword) return { code: 'OFF_TOPIC', weight: 0.4, message: `Text is not about a road incident (similarity ${r2(acc)})`, similarity: r2(acc) };
  if (off > acc + 0.1) return { code: 'OFF_TOPIC', weight: 0.3, message: `Text reads more like spam/chatter than an incident (${r2(off)} vs ${r2(acc)})`, similarity: r2(acc) };
  return null;
}

// ── Text integrity check ────────────────────────────────────────────────────

const reportText = (r) => [r.description, r.title && !/^User Report:/i.test(r.title) ? r.title : '', r.location].filter(Boolean).join('. ').slice(0, 600);

function dayDiff(a, b) {
  if (!a || !b) return null;
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/**
 * Semantic duplicate + spam analysis for one report against existing records.
 * `report`: normalised record ({ id, description, title, location, lat, lng, date, reporterId, createdAt }).
 */
export async function checkReportText(report, records, { forceFallback = false } = {}) {
  const text = reportText(report);
  const signals = heuristicSpamSignals(report.description || text, { letterModel: letterModelFor(records) });

  // Candidates for duplicates: nearby, not rejected, not itself.
  const others = records.filter(r => r.id !== report.id && r.status !== 'hidden' && r.lat != null && report.lat != null);
  const nearby = others
    .map(r => ({ r, d: haversineM(report.lat, report.lng, r.lat, r.lng) }))
    .filter(x => x.d <= 1500)
    .filter(x => { const dd = dayDiff(report.date, x.r.date); return dd == null || dd <= 2; });

  // Text reuse anywhere in the city: same description filed for a different place/date.
  const withDesc = others.filter(r => (r.description || '').length >= 20);
  const pool = [...new Map([...nearby.map(x => x.r), ...withDesc].map(r => [r.id, r])).values()].slice(0, 400);

  const { vectors, method } = await embedTexts([text, ...pool.map(reportText)], { forceFallback });
  const q = vectors[0];
  const simOf = new Map(pool.map((r, i) => [r.id, cosine(q, vectors[i + 1])]));
  const [lo, span] = method === 'hashed-tfidf' ? [0.1, 0.7] : [0.3, 0.6];
  const norm = (s) => Math.max(0, Math.min(1, (s - lo) / span));

  const duplicates = nearby.map(({ r, d }) => {
    const sim = simOf.get(r.id) ?? 0;
    const dd = dayDiff(report.date, r.date);
    const dateScore = dd == null ? 0.3 : dd === 0 ? 1 : dd <= 1 ? 0.7 : 0.4;
    const score = 0.55 * norm(sim) + 0.3 * Math.max(0, 1 - d / 1500) + 0.15 * dateScore;
    return { id: r.id, title: r.title, location: r.location || r.area, date: r.date, status: r.status, distanceM: Math.round(d), textSimilarity: r2(sim), score: r2(score) };
  }).filter(x => x.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 5);

  const reused = withDesc
    .filter(r => (simOf.get(r.id) ?? 0) >= (method === 'hashed-tfidf' ? 0.9 : 0.95))
    .filter(r => r.lat == null || report.lat == null || haversineM(report.lat, report.lng, r.lat, r.lng) > 2000 || (dayDiff(report.date, r.date) ?? 0) > 2);
  if (reused.length) signals.push({ code: 'REUSED_TEXT', weight: 0.3, message: `Description nearly identical to ${reused.length} report(s) at a different place/date`, ids: reused.slice(0, 5).map(r => r.id) });

  // Judge relevance on what the reporter wrote; location names ("... Junction", "... Road") would mask off-topic text.
  const rel = await relevanceSignal((report.description || "").trim().length >= 10 ? report.description : text, method);
  if (rel) signals.push(rel);

  if (report.reporterId) {
    const since = Date.now() - 24 * 3600 * 1000;
    const recent = records.filter(r => r.reporterId === report.reporterId && r.createdAt && Date.parse(r.createdAt) >= since).length;
    if (recent >= 8) signals.push({ code: 'REPORT_FLOOD', weight: 0.35, message: `${recent} reports from this account in 24 h` });
    else if (recent >= 4) signals.push({ code: 'HIGH_VELOCITY', weight: 0.2, message: `${recent} reports from this account in 24 h` });
  }

  const spamScore = r2(noisyOr(signals.map(s => s.weight)));
  const top = duplicates[0];
  const duplicateVerdict = top && top.score >= 0.7 && top.distanceM <= 500 ? 'likely_duplicate' : top ? 'possible_duplicate' : 'none';
  return {
    method,
    spamScore,
    spamVerdict: spamScore >= 0.6 ? 'likely_spam' : spamScore >= 0.3 ? 'review' : 'ok',
    signals,
    duplicates,
    duplicateVerdict,
  };
}

// ── Image forensics ─────────────────────────────────────────────────────────

let sharpMod = null;
async function sharp() {
  if (!sharpMod) sharpMod = (await import('sharp')).default;
  return sharpMod;
}

/** 64-bit difference hash (dHash) as 16 hex chars; robust to resizing/re-compression. */
export async function dHash(buffer) {
  const S = await sharp();
  const { data } = await S(buffer).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/**
 * Error Level Analysis: re-save as JPEG q90 and measure per-block differences.
 * Regions pasted/edited after the last save often re-compress differently.
 */
export async function errorLevelAnalysis(buffer, { withImage = true } = {}) {
  const S = await sharp();
  const meta = await S(buffer).metadata();
  if (meta.format !== 'jpeg') return { applicable: false, reason: 'ELA only applies to JPEG images' };
  if ((meta.width || 0) * (meta.height || 0) > 16e6) return { applicable: false, reason: 'Image too large for ELA' };
  const base = S(buffer).removeAlpha().toColourspace('srgb');
  const { data: a, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const re = await base.clone().jpeg({ quality: 90 }).toBuffer();
  const { data: b } = await S(re).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const diff = new Uint8Array(W * H);
  for (let p = 0, q = 0; p < W * H; p++, q += C) {
    diff[p] = Math.max(Math.abs(a[q] - b[q]), Math.abs(a[q + 1] - b[q + 1]), Math.abs(a[q + 2] - b[q + 2]));
  }
  const B = 16, bw = Math.floor(W / B), bh = Math.floor(H / B);
  const blocks = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) s += diff[(by * B + y) * W + bx * B + x];
      blocks.push(s / (B * B));
    }
  }
  const mean = blocks.reduce((x, y) => x + y, 0) / (blocks.length || 1);
  const sd = Math.sqrt(blocks.reduce((x, y) => x + (y - mean) ** 2, 0) / (blocks.length || 1));
  const sorted = [...blocks].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const outliers = blocks.filter(v => v > mean + 3 * sd && v > 4).length;
  const outlierRatio = blocks.length ? outliers / blocks.length : 0;
  const peak = sorted[sorted.length - 1] || 0;
  const localized = outlierRatio > 0.004 && outlierRatio < 0.15 && peak > Math.max(6, 3 * (median + 0.5));

  let image = null;
  if (withImage) {
    const vis = Buffer.alloc(W * H);
    const scale = 255 / Math.max(8, Math.min(40, peak));
    for (let p = 0; p < W * H; p++) vis[p] = Math.min(255, diff[p] * scale);
    const png = await S(vis, { raw: { width: W, height: H, channels: 1 } }).resize({ width: 480, withoutEnlargement: true }).png().toBuffer();
    image = `data:image/png;base64,${png.toString('base64')}`;
  }
  return { applicable: true, meanError: r2(mean), medianBlockError: r2(median), peakBlockError: r2(peak), outlierBlockRatio: Math.round(outlierRatio * 10000) / 10000, localizedAnomaly: localized, image };
}

const AI_TOOL_RE = /stable.?diffusion|midjourney|dall.?e|firefly|imagen|ai.generated|generative|comfyui|automatic1111|novelai|leonardo\.ai|sdxl|flux\.1|ideogram|gemini|chatgpt|openai/i;
const EDITOR_RE = /photoshop|gimp|lightroom|snapseed|picsart|canva|facetune|pixlr|affinity|paint\.net|photopea|remini/i;
const SCREEN_WIDTHS = new Set([720, 750, 828, 1080, 1125, 1170, 1179, 1242, 1284, 1290, 1440, 1366, 1536, 1920, 2560]);

async function readExif(buffer) {
  try {
    const exifr = (await import('exifr')).default;
    return await exifr.parse(buffer, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, mergeOutput: true }) || null;
  } catch { return null; }
}

async function aiDetector(buffer) {
  if (process.env.AI_DISABLE_IMAGE_DETECTOR === 'true') return null;
  const model = process.env.AI_IMAGE_DETECTOR_MODEL || DEFAULT_IMAGE_DETECTOR;
  const clf = await getPipeline('image-classification', model);
  if (!clf) return null;
  const mod = await transformers();
  const S = await sharp();
  const png = await S(buffer).rotate().removeAlpha().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const img = await mod.RawImage.fromBlob(new Blob([png], { type: 'image/png' }));
  const out = await clf(img, { top_k: 5 });
  const fake = out.find(o => /artificial|fake|ai|generated|synthetic/i.test(o.label));
  return { model, aiProbability: r2(fake ? fake.score : 0), labels: out.map(o => ({ label: o.label, score: r2(o.score) })) };
}

async function visionLlmCheck(buffer) {
  if (!llmAvailable()) return { skipped: 'LLM unavailable or daily free budget used' };
  const S = await sharp();
  const jpg = await S(buffer).rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const { json, model } = await chatJSON({
    models: visionModels(),
    temperature: 0,
    maxTokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'You help moderators verify photos submitted as proof of a road accident in Bengaluru. Answer with JSON only: {"is_camera_photo": boolean, "shows_road_incident_or_vehicle_damage": boolean, "looks_ai_generated": boolean, "looks_like_screenshot_stock_or_downloaded": boolean, "notes": "one short sentence"}' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpg.toString('base64')}` } },
      ],
    }],
    validate: (j) => { if (typeof j?.looks_ai_generated !== 'boolean') throw new Error('Missing fields'); },
  });
  return { model, ...json };
}

/**
 * Analyse an uploaded proof image.
 * @param {Buffer} buffer
 * @param {{ reported?: {lat,lng,date}, knownHashes?: {id,hash}[], selfId?: string, deep?: boolean, withElaImage?: boolean }} opts
 */
export async function analyzeImage(buffer, { reported = {}, knownHashes = [], selfId = null, deep = false, withElaImage = true } = {}) {
  const S = await sharp();
  const meta = await S(buffer).metadata();
  const signals = [];
  const add = (code, weight, message, extra = {}) => signals.push({ code, weight, message, ...extra });

  const exif = await readExif(buffer);
  const make = exif?.Make || null, camModel = exif?.Model || null;
  const software = [exif?.Software, exif?.CreatorTool, exif?.ProcessingSoftware, exif?.HistorySoftwareAgent].filter(Boolean).join(' ');
  const metaText = `${software} ${exif?.Description || ''} ${exif?.ImageDescription || ''} ${exif?.Credit || ''} ${exif?.DigitalSourceType || ''}`;
  const taken = exif?.DateTimeOriginal || exif?.CreateDate || null;
  const gps = exif?.latitude != null && exif?.longitude != null ? { lat: exif.latitude, lng: exif.longitude } : null;

  if (AI_TOOL_RE.test(metaText) || /trainedAlgorithmicMedia/i.test(metaText)) add('AI_METADATA', 0.8, 'Metadata names an AI image generator');
  const head = buffer.subarray(0, Math.min(buffer.length, 200000)).toString('latin1');
  if (/c2pa|jumbf/i.test(head)) add('CONTENT_CREDENTIALS', 0.15, 'Carries C2PA content credentials — check the provenance (AI tools and some phones add these)');
  if (EDITOR_RE.test(software)) add('EDITED', 0.3, `Saved by editing software (${software.trim().slice(0, 60)})`);
  if (!make && !camModel) add('NO_CAMERA_METADATA', 0.1, 'No camera make/model (common for WhatsApp/social-media copies)');
  if (taken && reported.date) {
    const days = Math.abs((new Date(taken) - Date.parse(`${reported.date}T12:00:00`)) / 86400000);
    if (Number.isFinite(days) && days > 2) add('DATE_MISMATCH', 0.35, `Photo taken ${Math.round(days)} day(s) away from the reported accident date`);
  }
  if (gps && reported.lat != null) {
    const d = haversineM(gps.lat, gps.lng, reported.lat, reported.lng);
    if (d > 3000) add('GPS_MISMATCH', 0.4, `Photo GPS is ${(d / 1000).toFixed(1)} km from the reported pin`);
  }
  if (meta.format === 'png' && !exif && SCREEN_WIDTHS.has(meta.width)) add('SCREENSHOT_LIKE', 0.25, `PNG at a screen width (${meta.width}px) with no camera data — possibly a screenshot`);
  if (Math.max(meta.width || 0, meta.height || 0) < 400) add('LOW_RESOLUTION', 0.15, `Very small image (${meta.width}×${meta.height}) — often a downloaded thumbnail`);

  const hash = await dHash(buffer);
  const matches = knownHashes.filter(k => k.id !== selfId && k.hash && hamming(hash, k.hash) <= 6).map(k => ({ id: k.id, distance: hamming(hash, k.hash) }));
  if (matches.length) add('REUSED_IMAGE', 0.6, `Same photo as ${matches.length} earlier report(s)`, { ids: matches.map(m => m.id) });

  let ela = null;
  try {
    ela = await errorLevelAnalysis(buffer, { withImage: withElaImage });
    if (ela.applicable && ela.localizedAnomaly) add('ELA_ANOMALY', 0.2, 'Error-level analysis shows a localised region that re-compresses differently (possible edit)');
  } catch (e) { ela = { applicable: false, reason: e.message }; }

  let detector = null;
  try {
    detector = await aiDetector(buffer);
    if (detector) {
      // Measured on real accident photos: the detector is dependable at original
      // resolution but gives false positives on images that were already shrunk
      // below ~600 px and re-compressed (forwarded thumbnails). Down-weight those.
      detector.reliable = Math.min(meta.width || 0, meta.height || 0) >= 600;
      const pctAi = Math.round(detector.aiProbability * 100);
      const note = detector.reliable ? '' : ' (low-resolution/re-compressed input, where this detector is unreliable)';
      if (detector.aiProbability >= 0.85) add('AI_DETECTOR', detector.reliable ? 0.75 : 0.2, `AI-image detector: ${pctAi}% likely AI-generated${note}`);
      else if (detector.aiProbability >= 0.6) add('AI_DETECTOR', detector.reliable ? 0.35 : 0.1, `AI-image detector: ${pctAi}% likely AI-generated${note}`);
    }
  } catch (e) { detector = { error: e.message }; }

  let vision = null;
  if (deep) {
    try {
      vision = await visionLlmCheck(buffer);
      if (vision.looks_ai_generated) add('VISION_LLM_AI', 0.4, `Vision model: looks AI-generated${vision.notes ? ` — ${vision.notes}` : ''}`);
      if (vision.looks_like_screenshot_stock_or_downloaded) add('VISION_LLM_STOCK', 0.3, 'Vision model: looks like a screenshot, stock or downloaded image');
      if (vision.shows_road_incident_or_vehicle_damage === false) add('VISION_LLM_IRRELEVANT', 0.35, 'Vision model: does not show a road incident or vehicle damage');
    } catch (e) { vision = { error: e.message }; }
  }

  const fakeScore = r2(noisyOr(signals.map(s => s.weight)));
  return {
    fakeScore,
    verdict: fakeScore >= 0.6 ? 'likely_fake' : fakeScore >= 0.3 ? 'needs_review' : 'likely_authentic',
    signals,
    image: { format: meta.format, width: meta.width, height: meta.height, bytes: buffer.length, hash },
    exif: exif ? { make, model: camModel, software: software || null, taken: taken ? new Date(taken).toISOString() : null, gps } : null,
    ela,
    detector,
    vision,
    caveat: 'Automated forensics are indicators, not proof. Screenshots and forwarded photos lose metadata; always confirm visually.',
  };
}

// ── Safe image fetching (SSRF guard) ────────────────────────────────────────

export function allowedImageHosts() {
  const hosts = new Set();
  try { if (process.env.SUPABASE_URL) hosts.add(new URL(process.env.SUPABASE_URL).host); } catch { /* ignore */ }
  hosts.add('xcjzfifybnzocyjlktpo.supabase.co');
  String(process.env.IMAGE_FETCH_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(h => hosts.add(h));
  return hosts;
}

/** Download a proof image, but only from our own storage hosts over HTTPS (prevents SSRF). */
export async function fetchProofImage(url, { fetchImpl = globalThis.fetch, maxBytes = 12 * 1024 * 1024 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid image URL'); }
  if (u.protocol !== 'https:') throw new Error('Only https image URLs are allowed');
  if (!allowedImageHosts().has(u.host)) throw new Error(`Image host ${u.host} is not allow-listed`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchImpl(u.toString(), { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error(`Not an image (${type || 'unknown type'})`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('Image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('Image too large');
    return buf;
  } finally { clearTimeout(t); }
}

// ── Combined check + persistence ────────────────────────────────────────────

export function overallVerdict(text, image) {
  const reasons = [];
  if (text?.duplicateVerdict === 'likely_duplicate') reasons.push('Likely duplicate of an existing report');
  if (text?.spamVerdict === 'likely_spam') reasons.push('Text looks like spam');
  if (image?.verdict === 'likely_fake') reasons.push('Photo looks fake or reused');
  const score = r2(Math.max(text?.spamScore || 0, image?.fakeScore || 0, text?.duplicates?.[0]?.score >= 0.7 ? text.duplicates[0].score : 0));
  let verdict = 'looks_ok';
  if (text?.duplicateVerdict === 'likely_duplicate') verdict = 'likely_duplicate';
  if (text?.spamVerdict === 'likely_spam' || image?.verdict === 'likely_fake') verdict = 'likely_fake_or_spam';
  else if (verdict === 'looks_ok' && (text?.spamVerdict === 'review' || image?.verdict === 'needs_review' || text?.duplicateVerdict === 'possible_duplicate')) verdict = 'needs_review';
  if (verdict === 'needs_review' && !reasons.length) reasons.push('Some weak signals — worth a quick look');
  return { verdict, score, reasons };
}

export function createIntegrityService({ dataset, pool = null, supabase = null, cacheDir = null, logger = console }) {
  const file = cacheDir ? path.join(cacheDir, 'integrity.json') : null;
  let store = {};
  try { if (file && fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { store = {}; }
  if (cacheDir) setModelCacheDir(path.join(cacheDir, 'models'));
  const running = new Map();

  function persist(id, result) {
    store[id] = result;
    if (file) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(store)); }
      catch (e) { logger.warn?.('[ai/integrity] cache write failed:', e.message); }
    }
    const slim = { ...result, image: result.image ? { ...result.image, ela: result.image.ela ? { ...result.image.ela, image: undefined } : null } : null };
    // Mirror to the database when the optional columns exist (see Database/schema.sql).
    if (pool) pool.query('UPDATE accidents SET integrity = $2::jsonb, image_phash = $3 WHERE id = $1', [id, JSON.stringify(slim), result.image?.image?.hash || null]).catch(() => {});
    if (supabase) Promise.resolve(supabase.from('accidents').update({ integrity: slim, image_phash: result.image?.image?.hash || null }).eq('id', id)).catch(() => {});
  }

  const knownHashes = () => Object.entries(store).map(([id, r]) => ({ id, hash: r.image?.image?.hash })).filter(k => k.hash);

  async function run(id, { deep = false, imageBuffer = null } = {}) {
    const records = await dataset.all();
    const report = records.find(r => r.id === String(id));
    if (!report) throw new Error('Report not found');
    const text = await checkReportText(report, records);
    let image = null;
    if (imageBuffer || report.proofUrl) {
      try {
        const buf = imageBuffer || await fetchProofImage(report.proofUrl);
        image = await analyzeImage(buf, { reported: { lat: report.lat, lng: report.lng, date: report.date }, knownHashes: knownHashes(), selfId: report.id, deep });
      } catch (e) {
        image = { error: e.message, verdict: 'needs_review', fakeScore: 0.3, signals: [{ code: 'IMAGE_UNAVAILABLE', weight: 0.3, message: `Could not analyse the photo: ${e.message}` }] };
      }
    }
    const result = { id: report.id, version: INTEGRITY_VERSION, checkedAt: new Date().toISOString(), overall: overallVerdict(text, image), text, image };
    persist(report.id, result);
    return result;
  }

  const current = (id) => (store[String(id)]?.version === INTEGRITY_VERSION ? store[String(id)] : null);

  return {
    get: current,
    summaries(ids) {
      return Object.fromEntries(ids.map(id => { const r = current(id); return [id, r ? { ...r.overall, checkedAt: r.checkedAt } : null]; }));
    },
    /** Run (or join an in-flight run of) the full check for one report. */
    check(id, opts = {}) {
      const key = `${id}|${opts.deep ? 'deep' : 'std'}`;
      if (!running.has(key)) running.set(key, run(id, opts).finally(() => running.delete(key)));
      return running.get(key);
    },
    /** Ad-hoc image test (admin lab) — not persisted. */
    analyzeUpload(buffer, opts = {}) { return analyzeImage(buffer, { ...opts, knownHashes: knownHashes() }); },
    /** Warm the local models in the background so the first real check is fast. */
    async prewarm() {
      await embedTexts(['warm up']);
      const S = await sharp();
      const blank = await S({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
      await aiDetector(blank).catch(() => null);
    },
  };
}

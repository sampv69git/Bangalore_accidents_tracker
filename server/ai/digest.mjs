/**
 * LLM weekly digest — grounded generation.
 *
 *  1. Facts are computed deterministically from the data (counts, shares,
 *     week-over-week change, top areas, peak day/hour, notable incidents).
 *  2. A free LLM turns the facts into a short readable digest.
 *  3. Every number in the LLM's text is checked against the facts; if any
 *     number is unsupported (a hallucination), the LLM text is discarded and a
 *     deterministic template is used instead.
 *
 * If the requested week has too little data, the window widens (30/90/365
 * days) and the digest says so. Results are cached on disk so the same facts
 * never spend free-tier quota twice.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chatJSON, llmAvailable, unsupportedNumbers, severityClaimErrors } from './llm.mjs';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MIN_INCIDENTS = 3;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function inWindow(r, start, end) { return r.date && r.date > start && r.date <= end; }

function tally(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const areaName = (r) => (r.area && r.area.length <= 40 ? r.area : r.location || '').trim() || null;

function timeBand(h) {
  if (h >= 7 && h < 11) return 'morning rush (7–11 am)';
  if (h >= 11 && h < 17) return 'daytime (11 am–5 pm)';
  if (h >= 17 && h < 21) return 'evening rush (5–9 pm)';
  return 'night (9 pm–7 am)';
}

export function computeDigestFacts(records, { period = 'week', asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const requested = period === 'month' ? 30 : 7;
  const dated = records.filter(r => r.date && r.status === 'active');
  const latest = dated.reduce((m, r) => (r.date > m ? r.date : m), '');
  const lengths = [...new Set([requested, 30, 90, 365])].filter(l => l >= requested);

  let chosen = null;
  for (const anchor of [asOf, latest].filter(Boolean)) {
    for (const len of lengths) {
      const start = addDays(anchor, -len);
      const n = dated.filter(r => inWindow(r, start, anchor)).length;
      if (n >= MIN_INCIDENTS) { chosen = { anchor, len }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) chosen = { anchor: latest || asOf, len: lengths[lengths.length - 1] };

  const { anchor, len } = chosen;
  const start = addDays(anchor, -len);
  const prevStart = addDays(anchor, -2 * len);
  const cur = dated.filter(r => inWindow(r, start, anchor));
  const prev = dated.filter(r => inWindow(r, prevStart, start));

  const sev = { fatal: 0, serious: 0, minor: 0 };
  cur.forEach(r => { sev[r.severity]++; });

  const areas = tally(cur, areaName);
  const prevAreas = new Set(prev.map(areaName));
  const zones = tally(cur, r => r.zone || null);
  const days = tally(cur, r => (r.dow != null ? DAY_NAMES[r.dow] : null));
  const withHour = cur.filter(r => r.hour != null);
  const bands = tally(withHour, r => timeBand(r.hour));

  const facts = {
    period: {
      requested: period === 'month' ? 'month' : 'week',
      days: len,
      start: addDays(start, 1),
      end: anchor,
      widened: len !== requested,
      anchoredToLatestData: anchor !== asOf,
      latestDataDate: latest || null,
    },
    total: cur.length,
    previousTotal: prev.length,
    changePct: prev.length ? Math.round(((cur.length - prev.length) / prev.length) * 100) : null,
    severity: sev,
    fatalSharePct: pct(sev.fatal, cur.length),
    topAreas: areas.slice(0, 3).map(([area, count]) => ({ area, zone: cur.find(r => areaName(r) === area)?.zone || null, count, sharePct: pct(count, cur.length) })),
    topZone: zones[0] ? { zone: zones[0][0], count: zones[0][1], sharePct: pct(zones[0][1], cur.length) } : null,
    peakDay: days[0] && days[0][1] >= 2 ? { day: days[0][0], count: days[0][1] } : null,
    peakTimeBand: withHour.length >= 3 && bands[0] ? { band: bands[0][0], count: bands[0][1], sharePct: pct(bands[0][1], withHour.length) } : null,
    newAreas: areas.map(([a]) => a).filter(a => !prevAreas.has(a)).slice(0, 3),
    userReports: cur.filter(r => r.isUser).length,
    notable: cur.filter(r => r.severity === 'fatal').slice(0, 3)
      .map(r => ({ date: r.date, area: areaName(r), title: (r.title || '').slice(0, 110) })),
    coverage: { undatedIncidents: records.filter(r => r.status === 'active' && !r.date).length, totalIncidents: records.filter(r => r.status === 'active').length },
  };
  return facts;
}

export function templateDigest(f) {
  const range = `${fmtDate(f.period.start)} – ${fmtDate(f.period.end)}`;
  const label = f.period.widened ? `the last ${f.period.days} days` : `the ${f.period.requested}`;
  const headline = f.total
    ? `${f.total} incident${f.total === 1 ? '' : 's'} recorded in ${label} (${range})`
    : `No dated incidents in ${label} (${range})`;
  const bullets = [];
  if (f.changePct != null) bullets.push(`${f.changePct >= 0 ? 'Up' : 'Down'} ${Math.abs(f.changePct)}% from ${f.previousTotal} in the previous ${f.period.days} days.`);
  else if (f.total) bullets.push(`No incidents were recorded in the previous ${f.period.days} days, so no trend comparison is possible.`);
  if (f.total) bullets.push(`Severity: ${f.severity.fatal} fatal, ${f.severity.serious} serious, ${f.severity.minor} minor (${f.fatalSharePct}% fatal).`);
  if (f.topAreas.length) bullets.push(`Most affected: ${f.topAreas.map(a => `${a.area} (${a.count}, ${a.sharePct}%)`).join(', ')}.`);
  if (f.peakTimeBand) bullets.push(`${f.peakTimeBand.sharePct}% of timed incidents happened during the ${f.peakTimeBand.band}.`);
  if (f.peakDay) bullets.push(`${f.peakDay.day} had the most incidents (${f.peakDay.count}).`);
  if (f.userReports) bullets.push(`${f.userReports} of these came from citizen reports.`);

  let summary = f.total
    ? `Bengaluru recorded ${f.total} road incident${f.total === 1 ? '' : 's'} between ${range}` +
      (f.topAreas[0] ? `, with ${f.topAreas[0].area} accounting for ${f.topAreas[0].sharePct}%.` : '.')
    : `No incidents with a known date fall in ${label}.`;
  if (f.period.widened || f.period.anchoredToLatestData) {
    summary += ` The window was widened${f.period.anchoredToLatestData ? ` and anchored to the latest dated record (${fmtDate(f.period.latestDataDate)})` : ''} because the requested ${f.period.requested} had fewer than ${MIN_INCIDENTS} dated incidents.`;
  }
  const advice = f.topAreas[0]
    ? `Take extra care around ${f.topAreas[0].area}, and use the Safe Route planner to compare alternatives.`
    : 'Drive defensively and report any incident you witness so the map stays current.';
  return { headline, summary, bullets, advice };
}

function digestPrompt(facts) {
  return [
    {
      role: 'system',
      content: 'You write a short, factual road-safety digest for Bengaluru residents. Use ONLY the numbers, places and dates given in FACTS; never invent causes, numbers or locations. "total" counts incidents of ALL severities; only severity.fatal of them were fatal, and the data does not give how many people died, so never describe the total as deaths or lives lost. Only link an area to a zone if FACTS gives that pairing. If the window was widened or the data is thin, say so plainly. Respond with JSON only: {"headline": string (max 14 words), "summary": string (3-4 sentences), "bullets": [3-5 short strings], "advice": string (one practical tip grounded in the facts)}.',
    },
    { role: 'user', content: `FACTS:\n${JSON.stringify(facts)}` },
  ];
}

export async function generateDigest(facts, { useLLM = true, chat = chatJSON } = {}) {
  const template = templateDigest(facts);
  const base = { facts, generatedAt: new Date().toISOString() };
  if (!useLLM || !llmAvailable() || !facts.total) return { ...base, ...template, mode: 'template', grounded: true };
  try {
    const { json, model } = await chat({
      messages: digestPrompt(facts), temperature: 0.3, maxTokens: 3000,
      validate: (j) => { if (typeof j?.headline !== 'string' || typeof j?.summary !== 'string' || !j.headline.trim()) throw new Error('Reply missing headline/summary'); },
    });
    const out = {
      headline: String(json.headline || '').trim(),
      summary: String(json.summary || '').trim(),
      bullets: Array.isArray(json.bullets) ? json.bullets.map(String).slice(0, 5) : [],
      advice: String(json.advice || '').trim(),
    };
    if (!out.headline || !out.summary) throw new Error('Incomplete digest from model');
    const text = [out.headline, out.summary, ...out.bullets, out.advice].join(' ');
    const bad = unsupportedNumbers(text, { facts, extra: [7, 30, 90, 365] });
    const wrongSeverity = severityClaimErrors(text, facts.severity);
    if (bad.length || wrongSeverity.length) {
      const reason = [bad.length ? `unsupported numbers: ${bad.slice(0, 5).join(', ')}` : '', ...wrongSeverity].filter(Boolean).join('; ');
      return { ...base, ...template, mode: 'template', grounded: true, rejectedLLM: { model, reason } };
    }
    return { ...base, ...out, mode: 'llm', model, grounded: true };
  } catch (e) {
    return { ...base, ...template, mode: 'template', grounded: true, llmError: e.message };
  }
}

/** Disk-backed cache keyed by a hash of the facts, so identical data never costs another LLM call. */
export function createDigestService({ dataset, cacheDir, logger = console }) {
  const file = cacheDir ? path.join(cacheDir, 'digests.json') : null;
  let store = {};
  try { if (file && fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { store = {}; }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const keys = Object.keys(store);
      if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(k => delete store[k]);
      fs.writeFileSync(file, JSON.stringify(store, null, 1));
    } catch (e) { logger.warn?.('[ai/digest] cache write failed:', e.message); }
  }

  return {
    async get({ period = 'week', refresh = false, asOf } = {}) {
      const records = await dataset.all();
      const facts = computeDigestFacts(records, { period, asOf });
      const key = crypto.createHash('sha1').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
      const hit = store[key];
      // Reuse an LLM digest indefinitely; retry the LLM for a template result at most once an hour.
      const fresh = hit && (hit.mode === 'llm' || Date.now() - Date.parse(hit.generatedAt) < 3600 * 1000);
      if (!refresh && fresh) return { ...hit, cached: true };
      const digest = await generateDigest(facts);
      if (digest.mode === 'llm' || !store[key]) { store[key] = digest; persist(); }
      return digest;
    },
  };
}

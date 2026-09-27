/** Synthetic accident records for the AI feature tests (no network, deterministic). */
import { seededRandom } from '../../ai/geo.mjs';

export function makeRecord(over = {}) {
  return {
    id: String(over.id ?? Math.random()), title: 'Test incident', location: '', area: '', zone: 'Central',
    severity: 'minor', score: 1, date: null, hour: null, dow: null, lat: 12.97, lng: 77.59,
    status: 'active', description: '', source: 'News', link: null, reporterId: null, proofUrl: null,
    createdAt: null, isUser: false, ...over,
  };
}

/**
 * Two clusters plus background noise:
 *  - "Silk Board" (12.9170, 77.6230): 60 incidents, many fatal, on a flyover
 *  - "Hebbal"     (13.0358, 77.5970): 25 incidents
 *  - 40 scattered incidents across the city
 */
export function syntheticCity(seed = 7) {
  const rand = seededRandom(seed);
  const out = [];
  let id = 1;
  const jitter = (s) => (rand() - 0.5) * s;
  const dateFor = (i) => (i % 3 === 0 ? null : `20${20 + (i % 6)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`);
  for (let i = 0; i < 60; i++) out.push(makeRecord({ id: String(id++), title: 'Crash at Silk Board flyover', location: 'Silk Board Junction', area: 'Silk Board', zone: 'South', severity: i % 3 === 0 ? 'fatal' : i % 3 === 1 ? 'serious' : 'minor', lat: 12.917 + jitter(0.002), lng: 77.623 + jitter(0.002), date: dateFor(i), hour: i % 4 === 0 ? 22 : null }));
  for (let i = 0; i < 25; i++) out.push(makeRecord({ id: String(id++), title: 'Accident near Hebbal', location: 'Hebbal Flyover', area: 'Hebbal', zone: 'North', severity: i % 5 === 0 ? 'fatal' : 'minor', lat: 13.0358 + jitter(0.002), lng: 77.597 + jitter(0.002), date: dateFor(i) }));
  for (let i = 0; i < 40; i++) out.push(makeRecord({ id: String(id++), title: 'Minor collision', location: `Street ${i}`, area: `Area ${i % 8}`, zone: 'Other', severity: 'minor', lat: 12.85 + rand() * 0.25, lng: 77.5 + rand() * 0.25, date: dateFor(i) }));
  out.forEach(r => { if (r.date) r.dow = new Date(`${r.date}T12:00:00Z`).getUTCDay(); });
  return out;
}

/** Minimal Response-like object for mocking fetch. */
export function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

export function chatReply(content, model = 'test/model:free') {
  return jsonResponse({ model, choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

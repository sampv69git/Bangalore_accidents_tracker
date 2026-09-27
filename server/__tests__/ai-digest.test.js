import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeDigestFacts, templateDigest, generateDigest } from '../ai/digest.mjs';
import { resetBudget } from '../ai/llm.mjs';
import { makeRecord } from './fixtures/ai-fixtures.js';

const recs = [
  makeRecord({ id: '1', date: '2026-09-25', area: 'Whitefield', zone: 'East', severity: 'fatal', dow: 5 }),
  makeRecord({ id: '2', date: '2026-09-24', area: 'Whitefield', zone: 'East', severity: 'minor', dow: 4 }),
  makeRecord({ id: '3', date: '2026-09-22', area: 'Hebbal', zone: 'North', severity: 'serious', dow: 2 }),
  makeRecord({ id: '4', date: '2026-09-16', area: 'Hebbal', zone: 'North', severity: 'minor', dow: 3 }),
  makeRecord({ id: '5', date: null, area: 'Hebbal' }),
];

describe('computeDigestFacts', () => {
  it('summarises the requested week and compares with the previous one', () => {
    const f = computeDigestFacts(recs, { period: 'week', asOf: '2026-09-27' });
    expect(f.period.days).toBe(7);
    expect(f.period.widened).toBe(false);
    expect(f.total).toBe(3);
    expect(f.previousTotal).toBe(1);
    expect(f.changePct).toBe(200);
    expect(f.severity).toEqual({ fatal: 1, serious: 1, minor: 1 });
    expect(f.topAreas[0]).toMatchObject({ area: 'Whitefield', zone: 'East', count: 2 });
    expect(f.coverage.undatedIncidents).toBe(1);
  });

  it('widens the window (and says so) when the week is too quiet', () => {
    const f = computeDigestFacts(recs, { period: 'week', asOf: '2026-12-01' });
    expect(f.period.widened || f.period.anchoredToLatestData).toBe(true);
    expect(f.total).toBeGreaterThanOrEqual(3);
    expect(templateDigest(f).summary).toMatch(/widened/);
  });
});

describe('generateDigest', () => {
  const facts = computeDigestFacts(recs, { period: 'week', asOf: '2026-09-27' });
  beforeEach(() => { process.env.OPENROUTER_API_KEY = 'k'; delete process.env.AI_DISABLE_LLM; resetBudget(); });
  afterEach(() => { delete process.env.OPENROUTER_API_KEY; });

  it('uses the template when the LLM is unavailable', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const d = await generateDigest(facts);
    expect(d.mode).toBe('template');
    expect(d.headline).toMatch(/3 incidents/);
  });

  it('accepts an LLM digest whose numbers all match the facts', async () => {
    const chat = async () => ({ model: 'm:free', json: { headline: '3 incidents this week, up 200%', summary: 'Whitefield had 2 of the 3 incidents; 1 was fatal.', bullets: ['1 fatal, 1 serious, 1 minor'], advice: 'Take care near Whitefield.' } });
    const d = await generateDigest(facts, { chat });
    expect(d.mode).toBe('llm');
    expect(d.grounded).toBe(true);
  });

  it('rejects an LLM digest that invents a number', async () => {
    const chat = async () => ({ model: 'm:free', json: { headline: '14 incidents this week', summary: 'Things got worse.', bullets: [], advice: '' } });
    const d = await generateDigest(facts, { chat });
    expect(d.mode).toBe('template');
    expect(d.rejectedLLM.reason).toMatch(/14/);
  });

  it('rejects an LLM digest that calls every incident a death', async () => {
    const chat = async () => ({ model: 'm:free', json: { headline: '3 deaths on Bengaluru roads', summary: 'A grim week with 3 incidents.', bullets: [], advice: '' } });
    const d = await generateDigest(facts, { chat });
    expect(d.mode).toBe('template');
    expect(d.rejectedLLM.reason).toMatch(/fatal/);
  });
});

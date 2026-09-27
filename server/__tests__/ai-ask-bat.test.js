import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateFilters, placeMatcher, applyFiltersSoft, planWithRules, runTool, askBat } from '../ai/ask-bat.mjs';
import { trainRiskModel } from '../ai/risk-model.mjs';
import { resetBudget } from '../ai/llm.mjs';
import { syntheticCity, makeRecord } from './fixtures/ai-fixtures.js';

const records = syntheticCity();
const model = trainRiskModel(records);
const ctx = { records, model };

describe('tool argument validation', () => {
  it('drops unknown values and clamps ranges', () => {
    expect(validateFilters({ severity: 'catastrophic', zone: 'north', hour_from: 99, from: '2024', to: 'yesterday', place: '  Hebbal ' }))
      .toEqual({ zone: 'North', hour_from: 23, from: '2024-01-01', place: 'Hebbal' });
  });

  it('rejects tools that are not on the allow-list', () => {
    expect(runTool(ctx, 'run_sql', { q: 'DROP TABLE accidents' }).error).toMatch(/Unknown tool/);
  });
});

describe('place matching', () => {
  it('tolerates misspellings of long place names', () => {
    const m = placeMatcher('Kormangala');
    expect(m(makeRecord({ area: 'Koramangala' }))).toBe(true);
    expect(m(makeRecord({ area: 'Hebbal' }))).toBe(false);
  });
});

describe('time filter degradation', () => {
  it('drops a time filter that would exclude everything only for lack of times, and says so', () => {
    const res = applyFiltersSoft(records, { place: 'Hebbal', hour_from: 22, hour_to: 5 });
    expect(res.rows.length).toBe(25);
    expect(res.timeFilterDropped.recordsWithoutTime).toBe(25);
    const out = runTool(ctx, 'hotspots', { place: 'Hebbal', hour_from: 22, hour_to: 5 });
    expect(out.note).toMatch(/could not be applied/);
  });

  it('keeps the filter when timed records exist', () => {
    const res = applyFiltersSoft(records, { place: 'Silk Board', hour_from: 22, hour_to: 5 });
    expect(res.timeFilterDropped).toBeUndefined();
    expect(res.rows.every(r => r.hour === 22)).toBe(true);
  });
});

describe('rule-based planner', () => {
  const plan = (q) => planWithRules(q, records);
  it('maps questions to the right tools and filters', () => {
    expect(plan('Which Silk Board junctions are worst after 10pm?')[0]).toMatchObject({ tool: 'hotspots', args: { place: 'Silk Board', hour_from: 22, hour_to: 5 } });
    expect(plan('How many fatal accidents in Hebbal?')[0]).toMatchObject({ tool: 'count_incidents', args: { place: 'Hebbal', severity: 'fatal' } });
    expect(plan('Compare Hebbal vs Silk Board')[0]).toMatchObject({ tool: 'compare_places' });
    expect(plan('Where is risk predicted to be highest?')[0].tool).toBe('risk_forecast');
    expect(plan('Are accidents increasing each month?')[0]).toMatchObject({ tool: 'trend', args: { interval: 'month' } });
  });
});

describe('askBat', () => {
  beforeEach(() => { process.env.OPENROUTER_API_KEY = 'k'; delete process.env.AI_DISABLE_LLM; resetBudget(); });
  afterEach(() => { delete process.env.OPENROUTER_API_KEY; });

  it('answers offline with the rule planner', async () => {
    const r = await askBat('How many fatal accidents in Hebbal?', { records, model, useLLM: false });
    expect(r.mode).toBe('rules');
    expect(r.answer).toMatch(/5 fatal/);
    expect(r.chart.type).toBe('doughnut');
  });

  it('runs the plan → tool → answer loop with an LLM', async () => {
    const replies = [
      { thought: 'count fatal in Hebbal', calls: [{ tool: 'count_incidents', args: { place: 'Hebbal', severity: 'fatal' } }] },
      { answer: 'Hebbal has 5 fatal incidents in the data.', chart_from: 0, followups: ['Compare with Silk Board'] },
    ];
    let i = 0;
    const chat = async () => ({ model: 'test/model:free', json: replies[i++] });
    const r = await askBat('How many fatal accidents in Hebbal?', { records, model, chat });
    expect(r.mode).toBe('agent');
    expect(r.grounded).toBe(true);
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0].tool).toBe('count_incidents');
    expect(r.chart).toBeTruthy();
    expect(r.followups).toEqual(['Compare with Silk Board']);
  });

  it('replaces an answer that states figures not in the tool results', async () => {
    const replies = [
      { calls: [{ tool: 'count_incidents', args: { place: 'Hebbal' } }] },
      { answer: 'Hebbal had 97 crashes.' },
    ];
    let i = 0;
    const chat = async () => ({ model: 'test/model:free', json: replies[i++] });
    const r = await askBat('How many accidents in Hebbal?', { records, model, chat });
    expect(r.grounded).toBe(false);
    expect(r.answer).not.toMatch(/97/);
    expect(r.answer).toMatch(/25/);
    expect(r.groundingNote).toMatch(/97/);
  });

  it('falls back to rules if the LLM fails', async () => {
    const chat = async () => { throw new Error('429 rate limited'); };
    const r = await askBat('Compare Hebbal vs Silk Board', { records, model, chat });
    expect(r.mode).toBe('rules');
    expect(r.fallbackReason).toMatch(/429/);
  });
});

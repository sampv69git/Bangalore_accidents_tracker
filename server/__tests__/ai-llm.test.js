import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isFreeModel, ensureFreeModel, extractJson, unsupportedNumbers, severityClaimErrors, chatJSON, resetBudget, budgetStatus, clearLlmCache, textModels } from '../ai/llm.mjs';
import { chatReply, jsonResponse } from './fixtures/ai-fixtures.js';

describe('free-model guard', () => {
  it('accepts only :free models and the free router', () => {
    expect(isFreeModel('openrouter/free')).toBe(true);
    expect(isFreeModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(isFreeModel('openai/gpt-5')).toBe(false);
    expect(isFreeModel('')).toBe(false);
  });

  it('replaces a paid model with the free router unless explicitly allowed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ALLOW_PAID_MODELS;
    expect(ensureFreeModel('anthropic/some-paid-model')).toBe('openrouter/free');
    process.env.ALLOW_PAID_MODELS = 'true';
    expect(ensureFreeModel('anthropic/some-paid-model')).toBe('anthropic/some-paid-model');
    delete process.env.ALLOW_PAID_MODELS;
  });

  it('default model chain is entirely free', () => {
    delete process.env.OPENROUTER_AGENT_MODELS;
    delete process.env.OPENROUTER_AGENT_MODEL;
    expect(textModels().every(isFreeModel)).toBe(true);
  });
});

describe('extractJson', () => {
  it('parses fenced, chatty and stray-brace replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"b":{"c":[1,2]}} hope that helps')).toEqual({ b: { c: [1, 2] } });
    expect(extractJson('{\n{"a":"x}"}')).toEqual({ a: 'x}' });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('User Safety: safe')).toThrow();
  });
});

describe('grounding checks', () => {
  const facts = { total: 11, severity: { fatal: 6, serious: 0, minor: 5 }, changePct: -61, topAreas: [{ area: 'Whitefield', sharePct: 18 }], period: { end: '2025-11-08' } };

  it('flags numbers that are not in the facts', () => {
    expect(unsupportedNumbers('11 incidents, down 61%, Whitefield 18%', facts)).toEqual([]);
    expect(unsupportedNumbers('13 incidents were recorded', facts)).toEqual(['13']);
  });

  it('flags a real number attached to the wrong severity', () => {
    expect(severityClaimErrors('6 fatal and 5 minor incidents', facts.severity)).toEqual([]);
    expect(severityClaimErrors('11 lives lost this year', facts.severity)).toHaveLength(1);
    expect(severityClaimErrors('3 serious crashes', facts.severity)).toHaveLength(1);
  });
});

describe('chatJSON', () => {
  beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; delete process.env.AI_DISABLE_LLM; resetBudget(); clearLlmCache(); });
  afterEach(() => { delete process.env.OPENROUTER_API_KEY; });

  it('retries a malformed reply, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatReply('not json at all'))
      .mockResolvedValueOnce(chatReply({ ok: true }));
    const out = await chatJSON({ messages: [{ role: 'user', content: 'hi' }], models: ['a/x:free', 'b/y:free'], fetchImpl, cacheTtlMs: 0 });
    expect(out.json).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('a/x:free');
  });

  it('moves to the next model on an HTTP error such as 429', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(chatReply({ ok: 2 }));
    const out = await chatJSON({ messages: [{ role: 'user', content: 'x' }], models: ['a/x:free', 'b/y:free'], fetchImpl, cacheTtlMs: 0 });
    expect(out.json).toEqual({ ok: 2 });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe('b/y:free');
  });

  it('applies the validate callback and caches successful replies', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatReply({ wrong: 1 }))
      .mockResolvedValueOnce(chatReply({ headline: 'ok' }));
    const args = { messages: [{ role: 'user', content: 'cache me' }], models: ['a/x:free'], fetchImpl, validate: (j) => { if (!j.headline) throw new Error('Reply missing headline'); } };
    expect((await chatJSON(args)).json.headline).toBe('ok');
    expect((await chatJSON(args)).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops calling once the daily free budget is used', async () => {
    process.env.AI_DAILY_LLM_BUDGET = '1';
    resetBudget();
    const fetchImpl = vi.fn().mockResolvedValue(chatReply('garbage'));
    await expect(chatJSON({ messages: [{ role: 'user', content: 'b' }], models: ['a/x:free'], fetchImpl, cacheTtlMs: 0 })).rejects.toThrow(/budget/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(budgetStatus().remaining).toBe(0);
    delete process.env.AI_DAILY_LLM_BUDGET;
  });

  it('refuses to run without an API key', async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(chatJSON({ messages: [] })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

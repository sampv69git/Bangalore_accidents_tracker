/** Ask BAT — chat UI for the natural-language analytics agent (POST /api/ask). */
(function () {
  'use strict';
  const { api, el, renderChart, renderTable } = window.BATAI;

  const form = document.getElementById('ask-form');
  const input = document.getElementById('ask-input');
  const btn = document.getElementById('ask-btn');
  const convo = document.getElementById('conversation');
  const statusEl = document.getElementById('ai-status');

  async function loadStatus() {
    try {
      const s = await api('/api/ai/status');
      statusEl.textContent = s.llm.available
        ? `AI agent online — free model chain starting with ${s.llm.textModels[0]} (${s.llm.budget.remaining} free calls left today).`
        : 'AI model unavailable right now — answers come from the rule-based planner (still using live data).';
      statusEl.dataset.state = s.llm.available ? 'on' : 'off';
    } catch (_) {
      statusEl.textContent = 'Could not reach the BAT server. Start it with "npm start".';
      statusEl.dataset.state = 'error';
    }
  }

  function modeBadges(r) {
    const badges = [];
    if (r.mode === 'agent') badges.push(el('span', { class: 'ai-badge ai-badge-ai', text: `AI agent · ${String(r.model || '').split('/').pop()}` }));
    else badges.push(el('span', { class: 'ai-badge ai-badge-rules', text: 'Rule-based planner' }));
    badges.push(r.grounded
      ? el('span', { class: 'ai-badge ai-badge-ok', text: 'Figures verified against data' })
      : el('span', { class: 'ai-badge ai-badge-warn', text: 'Data-generated answer shown' }));
    return el('div', { class: 'ai-badges' }, badges);
  }

  function traceBlock(r) {
    if (!r.trace || !r.trace.length) return null;
    const items = r.trace.map(t => el('li', {}, [
      el('div', { class: 'trace-tool', text: `Step ${t.step}: ${t.tool}` }),
      t.thought ? el('div', { class: 'trace-thought', text: t.thought }) : null,
      el('code', { class: 'trace-args', text: JSON.stringify(clean(t.args)) }),
      el('div', { class: 'trace-summary', text: t.summary }),
    ]));
    return el('details', { class: 'trace' }, [el('summary', { text: `How I got this (${r.trace.length} tool call${r.trace.length > 1 ? 's' : ''})` }), el('ol', {}, items)]);
  }

  function clean(o) {
    const out = {};
    Object.entries(o || {}).forEach(([k, v]) => { if (v != null && v !== '') out[k] = v; });
    return out;
  }

  function renderAnswer(card, r) {
    card.querySelector('.answer-body').replaceChildren();
    const body = card.querySelector('.answer-body');
    body.appendChild(modeBadges(r));
    body.appendChild(el('p', { class: 'answer-text', text: r.answer }));
    if (r.groundingNote) body.appendChild(el('p', { class: 'answer-note', text: r.groundingNote }));
    if (r.fallbackReason) body.appendChild(el('p', { class: 'answer-note', text: 'The AI model was unavailable, so the rule-based planner answered.' }));
    if (r.chart) {
      const canvas = el('canvas', { 'aria-label': r.chart.title || 'Chart', role: 'img' });
      body.appendChild(el('div', { class: 'chart-box' }, [canvas]));
      renderChart(canvas, r.chart);
    }
    const table = renderTable(r.table);
    if (table) body.appendChild(table);
    const trace = traceBlock(r);
    if (trace) body.appendChild(trace);
    if (r.followups && r.followups.length) {
      body.appendChild(el('div', { class: 'followups' }, r.followups.map(q => el('button', { class: 'chip chip-sm', type: 'button', text: q, onclick: () => ask(q) }))));
    }
  }

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q) return;
    input.value = '';
    btn.disabled = true;
    const card = el('article', { class: 'qa-card' }, [
      el('div', { class: 'question', text: q }),
      el('div', { class: 'answer-body' }, [el('p', { class: 'thinking', text: 'Planning and running analysis tools…' })]),
    ]);
    convo.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const r = await api('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
      renderAnswer(card, r);
      loadStatus();
    } catch (e) {
      card.querySelector('.answer-body').replaceChildren(el('p', { class: 'answer-error', text: e.message }));
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  document.querySelectorAll('.suggestions .chip').forEach(c => c.addEventListener('click', () => ask(c.textContent)));

  const initial = new URLSearchParams(location.search).get('q');
  loadStatus();
  if (initial) ask(initial);
})();

/** Trends page: AI road-safety digest card (GET /api/digest?period=week|month). */
(function () {
  'use strict';
  const { api, el } = window.BATAI;
  const $ = (id) => document.getElementById(id);

  function fmt(iso) {
    return iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  }

  async function load(period) {
    document.querySelectorAll('.digest-toggle button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
    $('digest-headline').textContent = 'Generating digest…';
    $('digest-summary').textContent = '';
    $('digest-bullets').replaceChildren();
    $('digest-advice').hidden = true;
    $('digest-meta').textContent = '';
    try {
      const d = await api(`/api/digest?period=${period}`);
      const p = d.facts.period;
      $('digest-kicker').textContent = `${period === 'month' ? 'Monthly' : 'Weekly'} road-safety digest · ${fmt(p.start)} – ${fmt(p.end)}`;
      $('digest-headline').textContent = d.headline;
      $('digest-summary').textContent = d.summary;
      $('digest-bullets').replaceChildren(...(d.bullets || []).map(b => el('li', { text: b })));
      if (d.advice) { $('digest-advice').textContent = d.advice; $('digest-advice').hidden = false; }
      const how = d.mode === 'llm'
        ? `Written by a free AI model (${String(d.model || '').split('/').pop()}) from computed facts; every number was checked against the data.`
        : 'Generated automatically from the data (AI writer unavailable or its draft failed the fact check).';
      const widened = p.widened ? ` The ${p.requested} had too few dated incidents, so the window was widened to ${p.days} days.` : '';
      const cov = d.facts.coverage ? ` ${d.facts.coverage.undatedIncidents} of ${d.facts.coverage.totalIncidents} incidents have no date and are not counted.` : '';
      $('digest-meta').textContent = how + widened + cov;
    } catch (e) {
      $('digest-headline').textContent = 'Digest unavailable';
      $('digest-summary').textContent = e.message;
    }
  }

  document.querySelectorAll('.digest-toggle button').forEach(b => b.addEventListener('click', () => load(b.dataset.period)));
  load('week');
})();

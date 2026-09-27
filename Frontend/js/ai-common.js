/**
 * Shared helpers for the AI feature pages (Ask BAT, Safe Route, digest, risk layer).
 * Everything that displays model output uses textContent — never innerHTML — so
 * LLM text can't inject markup.
 */
(function () {
  'use strict';

  const API = ((window.BAT_CONFIG && window.BAT_CONFIG.apiBase) || '').replace(/\/$/, '');

  async function api(path, options = {}) {
    const res = await fetch(API + path, options);
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request failed (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** Create an element: el('div', { class: 'x', text: 'hi' }, [children]) */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    (Array.isArray(children) ? children : [children]).filter(Boolean).forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  const PALETTE = ['#dc2626', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#0ea5a4'];
  const SEV_COLORS = { Fatal: '#dc2626', Serious: '#f59e0b', Minor: '#3b82f6', All: '#0f172a' };

  /** Render a server-provided chart spec with Chart.js. Returns the Chart instance. */
  function renderChart(canvas, spec) {
    if (!window.Chart || !spec) return null;
    const isPie = spec.type === 'doughnut';
    const datasets = spec.datasets.map((d, i) => {
      const color = SEV_COLORS[d.label] || PALETTE[i % PALETTE.length];
      return {
        label: d.label,
        data: d.data,
        backgroundColor: isPie ? ['#dc2626', '#f59e0b', '#3b82f6'] : (spec.type === 'line' ? color + '22' : color),
        borderColor: isPie ? '#fff' : color,
        borderWidth: spec.type === 'line' ? 2 : 1,
        tension: 0.25,
        fill: spec.type === 'line' && i === 0,
        borderRadius: spec.type === 'bar' ? 4 : 0,
      };
    });
    return new window.Chart(canvas.getContext('2d'), {
      type: spec.type,
      data: { labels: spec.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: spec.horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: datasets.length > 1 || isPie, position: isPie ? 'bottom' : 'top' },
          title: { display: Boolean(spec.title), text: spec.title, font: { weight: '600' } },
        },
        scales: isPie ? {} : {
          x: { stacked: Boolean(spec.stacked), beginAtZero: true, grid: { display: !spec.horizontal ? false : true } },
          y: { stacked: Boolean(spec.stacked), beginAtZero: true, ticks: { autoSkip: false } },
        },
      },
    });
  }

  function renderTable(table) {
    if (!table || !table.rows || !table.rows.length) return null;
    return el('div', { class: 'ai-table-wrap' }, [
      el('table', { class: 'ai-table' }, [
        el('thead', {}, [el('tr', {}, table.columns.map(c => el('th', { text: String(c) })))]),
        el('tbody', {}, table.rows.map(r => el('tr', {}, r.map(v => el('td', { text: v == null ? '—' : String(v) }))))),
      ]),
    ]);
  }

  window.BATAI = { API, api, el, renderChart, renderTable };
})();

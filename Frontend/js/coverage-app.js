/**
 * coverage-app.js — ambulance-desert map (drive time from the nearest
 * emergency hospital to each accident cell) and SOS response-time metrics.
 */
(function () {
  'use strict';
  const E = window.BATE;
  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.querySelector('.viz-root'));
  const v = (name) => css.getPropertyValue(name).trim();
  const ETA_BINS = [
    { max: 10, color: v('--eta-1'), label: '≤ 10 min' },
    { max: 15, color: v('--eta-2'), label: '10–15 min' },
    { max: 20, color: v('--eta-3'), label: '15–20 min' },
    { max: Infinity, color: v('--eta-4'), label: '> 20 min' },
  ];
  const binFor = (m) => ETA_BINS.find(b => m <= b.max) || ETA_BINS[3];
  const fmt = (x, unit) => (x == null ? '—' : `${x}${unit || ''}`);

  window.Auth?.updateNavAuth?.();

  function kpis(el, tiles) {
    el.innerHTML = '';
    tiles.forEach(t => {
      const d = document.createElement('div');
      d.className = 'kpi';
      const val = document.createElement('div'); val.className = 'kpi-value'; val.textContent = t.value;
      const lab = document.createElement('div'); lab.className = 'kpi-label'; lab.textContent = t.label;
      d.append(val, lab);
      if (t.note) { const n = document.createElement('div'); n.className = 'kpi-note'; n.textContent = t.note; d.appendChild(n); }
      el.appendChild(d);
    });
  }

  function table(el, head, rows) {
    el.innerHTML = '';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    head.forEach(h => { const th = document.createElement('th'); th.textContent = h.label; if (h.num) th.className = 'num'; hr.appendChild(th); });
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    if (!rows.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = head.length; td.className = 'hint'; td.textContent = 'No data for this period yet.';
      tr.appendChild(td); tbody.appendChild(tr);
    }
    rows.forEach(r => {
      const tr = document.createElement('tr');
      r.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c == null ? '—' : String(c); if (head[i].num) td.className = 'num'; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    el.append(thead, tbody);
  }

  /* ── Coverage map ────────────────────────────────────────────────────── */
  let map = null, cellLayer = null, hospLayer = null, covData = null;

  function tooltipFor(c) {
    const el = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${E.eta(c.eta_min, c.eta_source)} from ${c.nearest ? c.nearest.name : 'nearest hospital'}`;
    const line2 = document.createElement('div');
    line2.textContent = `${c.accidents} accident${c.accidents === 1 ? '' : 's'} (${c.fatal} fatal, ${c.serious} serious)`;
    const line3 = document.createElement('div');
    line3.textContent = c.trauma ? `Trauma centre: ${c.trauma.name}, ${E.eta(c.trauma_eta_min)}` : 'No trauma centre nearby';
    el.append(strong, line2, line3);
    return el;
  }

  function renderCoverage(d) {
    covData = d;
    const s = d.summary;
    kpis($('cov-kpis'), [
      { value: fmt(s.within_10_min_pct, '%'), label: 'of accidents within 10 min of a hospital that can take accident victims' },
      { value: fmt(s.band_10_20_pct, '%'), label: 'are 10–20 min away' },
      { value: fmt(s.over_20_min_pct, '%'), label: 'are more than 20 min away' },
      { value: fmt(s.trauma_within_20_min_pct, '%'), label: 'within 20 min of a trauma centre', note: s.trauma_within_30_min_pct != null ? `${s.trauma_within_30_min_pct}% within 30 min` : '' },
      { value: s.median_eta_min == null ? '—' : `${Math.round(s.median_eta_min)} min`, label: 'median drive time', note: `${s.accidents} accidents in ${s.cells} cells` },
    ]);
    $('cov-method').textContent = `Computed ${new Date(d.computedAt).toLocaleString()} · routing: ${d.params.routing === 'osrm' ? 'OSRM road network' : d.params.routing === 'estimate' ? 'straight-line estimate (OSRM unavailable)' : 'OSRM, some cells estimated'} · ×${d.params.trafficFactor} daytime traffic allowance · ${d.hospitals.length} emergency-capable hospitals.`;

    if (!window.L) return;
    if (!map) {
      map = E.map($('cov-map'), E.BLR, 11);
      cellLayer = L.layerGroup().addTo(map);
      hospLayer = L.layerGroup();
    }
    cellLayer.clearLayers();
    const maxAcc = Math.max(1, ...d.cells.map(c => c.accidents));
    d.cells.slice().sort((a, b) => b.accidents - a.accidents).forEach(c => {
      const bin = binFor(c.eta_min ?? 99);
      L.circleMarker([c.lat, c.lng], {
        radius: 5 + 13 * Math.sqrt(c.accidents / maxAcc),
        color: '#ffffff', weight: 2, fillColor: bin.color, fillOpacity: 0.9,
      }).bindTooltip(tooltipFor(c), { direction: 'top', sticky: true }).addTo(cellLayer);
    });
    hospLayer.clearLayers();
    d.hospitals.filter(h => h.emergency_level === 'trauma').forEach(h => {
      const tip = document.createElement('span'); tip.textContent = h.name;
      L.marker([h.lat, h.lng], { icon: E.icons.hospital(), title: h.name }).bindTooltip(tip).addTo(hospLayer);
    });
    if (d.cells.length) map.fitBounds(L.latLngBounds(d.cells.map(c => [c.lat, c.lng])).pad(0.08));

    const list = $('deserts');
    list.innerHTML = '';
    if (!d.deserts.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Every accident cell is within 10 minutes of an emergency hospital.'; list.appendChild(li); }
    d.deserts.forEach(c => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      const t = document.createElement('strong'); t.textContent = `${E.eta(c.eta_min, c.eta_source)} to ${c.nearest ? c.nearest.name : '—'}`;
      const m = document.createElement('div'); m.className = 'hint';
      m.textContent = `${c.accidents} accident${c.accidents === 1 ? '' : 's'} (${c.fatal} fatal) · trauma centre ${c.trauma_eta_min != null ? E.eta(c.trauma_eta_min) : 'far'} · ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
      li.append(t, m);
      const zoom = () => map && map.setView([c.lat, c.lng], 14);
      li.addEventListener('click', zoom);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') zoom(); });
      list.appendChild(li);
    });

    table($('cov-table'), [
      { label: 'Location' }, { label: 'Accidents', num: true }, { label: 'Fatal', num: true }, { label: 'Drive (min)', num: true }, { label: 'Nearest hospital' }, { label: 'Trauma (min)', num: true },
    ], d.cells.slice().sort((a, b) => (b.eta_min ?? 0) - (a.eta_min ?? 0)).map(c => [
      `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`, c.accidents, c.fatal, c.eta_min, c.nearest ? c.nearest.name : '—', c.trauma_eta_min,
    ]));
  }

  $('show-hospitals').addEventListener('change', (e) => { if (map && hospLayer) (e.target.checked ? hospLayer.addTo(map) : map.removeLayer(hospLayer)); });

  async function loadCoverage() {
    try {
      const d = await E.api('/api/coverage');
      if (d.status === 'computing') {
        const p = d.progress;
        $('cov-status').innerHTML = `<div class="notice notice--info">Computing drive times from ${p ? `${p.done}/${p.total} batches` : 'the road network'}… this takes about a minute the first time.</div>`;
        setTimeout(loadCoverage, 4000);
        return;
      }
      $('cov-status').innerHTML = d.refreshing ? '<div class="notice notice--info">Showing the last result while it is being recomputed.</div>' : '';
      renderCoverage(d);
    } catch (e) {
      $('cov-status').innerHTML = `<div class="notice notice--danger">Could not load coverage: ${E.esc(e.message)}</div>`;
    }
  }

  /* ── Response metrics ────────────────────────────────────────────────── */
  const charts = {};
  const state = { days: 30, drills: false };

  function barChart(id, labels, data, yTitle, tipFmt) {
    if (!window.Chart) return;
    charts[id]?.destroy();
    charts[id] = new Chart($(id), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: v('--series-1'), hoverBackgroundColor: '#1c5cab', maxBarThickness: 24, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start' }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false, callbacks: { label: (c) => (c.raw == null ? 'No data' : tipFmt(c.raw)) } },
        },
        scales: {
          x: { grid: { display: false }, border: { color: v('--grid') }, ticks: { color: v('--axis-ink'), maxRotation: 0, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: v('--grid'), lineWidth: 1 }, border: { display: false }, ticks: { color: v('--axis-ink'), precision: 0, font: { size: 11 } }, title: { display: !!yTitle, text: yTitle, color: v('--axis-ink'), font: { size: 11 } } },
        },
      },
    });
  }

  function renderMetrics(m) {
    const s = m.summary;
    kpis($('m-kpis'), [
      { value: String(s.total), label: 'SOS alerts', note: s.merged_reports ? `+${s.merged_reports} duplicate reports merged` : '' },
      { value: s.median_accept_min == null ? '—' : `${s.median_accept_min} min`, label: 'median time until a hospital accepts', note: s.p90_accept_min != null ? `90% within ${s.p90_accept_min} min` : '' },
      { value: s.median_to_scene_min == null ? '—' : `${s.median_to_scene_min} min`, label: 'median SOS → ambulance on scene', note: s.reached ? `${s.reached} reached` : '' },
      { value: fmt(s.within_10_min_pct, '%'), label: 'reached within 10 minutes' },
      { value: fmt(s.golden_hour_pct, '%'), label: 'at hospital within the golden hour', note: s.transported ? `of ${s.transported} transported` : '' },
      { value: String(s.unanswered), label: 'alerts no hospital accepted in time' },
    ]);

    const dayLabels = m.daily.map(d => { const [, mm, dd] = d.date.split('-'); return `${Number(dd)}/${Number(mm)}`; });
    barChart('c-daily', dayLabels, m.daily.map(d => d.total), 'Alerts', (x) => `${x} alert${x === 1 ? '' : 's'}`);
    table($('t-daily'), [{ label: 'Date' }, { label: 'Alerts', num: true }, { label: 'Median to scene (min)', num: true }], m.daily.slice().reverse().map(d => [d.date, d.total, d.median_to_scene_min]));

    barChart('c-hour', m.byHour.map(h => String(h.hour).padStart(2, '0')), m.byHour.map(h => h.median_to_scene_min), 'Minutes', (x) => `${x} min median`);
    table($('t-hour'), [{ label: 'Hour (IST)' }, { label: 'Alerts', num: true }, { label: 'Median to scene (min)', num: true }], m.byHour.map(h => [`${String(h.hour).padStart(2, '0')}:00`, h.total, h.median_to_scene_min]));

    table($('t-zone'), [{ label: 'Zone' }, { label: 'Alerts', num: true }, { label: 'Reached', num: true }, { label: 'Accept (min)', num: true }, { label: 'To scene (min)', num: true }, { label: 'Unanswered', num: true }],
      m.byZone.map(z => [z.zone, z.total, z.reached, z.median_accept_min, z.median_to_scene_min, z.unanswered]));
    table($('t-hosp'), [{ label: 'Hospital' }, { label: 'Accepted', num: true }, { label: 'Accept (min)', num: true }, { label: 'Accept → scene (min)', num: true }],
      m.hospitals.map(h => [h.name, h.accepted, h.median_accept_min, h.median_accept_to_scene_min]));
    const totalAccepted = m.escalation.reduce((a, r) => a + r.accepted, 0);
    table($('t-round'), [{ label: 'Accepted in' }, { label: 'Alerts', num: true }, { label: 'Share', num: true }],
      m.escalation.map(r => [r.round <= 1 ? 'First round (nearest hospitals)' : `Round ${r.round} (after escalation)`, r.accepted, totalAccepted ? `${Math.round(r.accepted / totalAccepted * 100)}%` : '—']));
  }

  async function loadMetrics() {
    $('metrics').classList.add('is-loading');
    try {
      renderMetrics(await E.api(`/api/emergency-metrics?days=${state.days}${state.drills ? '&drills=1' : ''}`));
    } catch (e) {
      E.toast('Could not load response metrics: ' + e.message, 'error');
    } finally {
      $('metrics').classList.remove('is-loading');
    }
  }

  $('period').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    state.days = Number(b.dataset.days);
    $('period').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    loadMetrics();
  });
  $('drills').addEventListener('change', (e) => { state.drills = e.target.checked; loadMetrics(); });

  loadCoverage();
  loadMetrics();
}());

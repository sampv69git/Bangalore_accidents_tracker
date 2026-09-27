/** Safe Route page — GET /api/routes/safe and map rendering with MapLibre. */
(function () {
  'use strict';
  const { api, el } = window.BATAI;

  const fromInput = document.getElementById('from-input');
  const toInput = document.getElementById('to-input');
  const statusEl = document.getElementById('route-status');
  const resultsEl = document.getElementById('route-results');
  const btn = document.getElementById('route-btn');
  const SEV_COLOR = { fatal: '#dc2626', serious: '#f59e0b', minor: '#3b82f6' };
  const RISK_COLOR = { medium: '#fde68a', high: '#fb923c', very_high: '#dc2626' };

  let lastResult = null;
  let riskLoaded = false;
  let activeId = null;
  const markers = [];

  const map = new maplibregl.Map({
    container: 'route-map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [77.5946, 12.9716],
    zoom: 11,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  const empty = { type: 'FeatureCollection', features: [] };
  map.on('load', () => {
    map.addSource('risk', { type: 'geojson', data: empty });
    map.addLayer({ id: 'risk-fill', type: 'fill', source: 'risk', layout: { visibility: 'none' }, paint: { 'fill-color': ['match', ['get', 'level'], 'very_high', RISK_COLOR.very_high, 'high', RISK_COLOR.high, RISK_COLOR.medium], 'fill-opacity': 0.35 } });
    map.addSource('routes', { type: 'geojson', data: empty });
    map.addLayer({ id: 'routes-other', type: 'line', source: 'routes', filter: ['!=', ['get', 'active'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#94a3b8', 'line-width': 5, 'line-opacity': 0.7 } });
    map.addLayer({ id: 'routes-active', type: 'line', source: 'routes', filter: ['==', ['get', 'active'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['get', 'recommended'], '#10b981', '#0f172a'], 'line-width': 7 } });
    map.addSource('incidents', { type: 'geojson', data: empty });
    map.addLayer({ id: 'incidents', type: 'circle', source: 'incidents', paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'severity'], 'fatal', SEV_COLOR.fatal, 'serious', SEV_COLOR.serious, SEV_COLOR.minor], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    map.on('click', 'routes-other', (e) => selectRoute(e.features[0].properties.id));
    map.on('click', 'incidents', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ offset: 8 })
        .setLngLat(e.features[0].geometry.coordinates)
        .setDOMContent(el('div', { style: 'font-size:12px;max-width:240px' }, [
          el('strong', { text: `${p.severity.toUpperCase()} · ${p.date || 'undated'}` }),
          el('div', { text: p.title }),
          el('div', { style: 'color:#64748b', text: `${p.distanceM} m from the route` }),
        ]))
        .addTo(map);
    });
    ['routes-other', 'incidents'].forEach(l => {
      map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    });

    const qs = new URLSearchParams(location.search);
    if (qs.get('from') && qs.get('to')) { fromInput.value = qs.get('from'); toInput.value = qs.get('to'); findRoute(); }
  });

  // Click the map: first click sets start (if empty), next sets destination.
  map.on('click', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['routes-other', 'incidents'] }).length) return;
    const v = `${e.lngLat.lat.toFixed(5)},${e.lngLat.lng.toFixed(5)}`;
    if (!fromInput.value.trim() || (fromInput.value && toInput.value)) { fromInput.value = v; toInput.value = ''; }
    else toInput.value = v;
    placeEndpoints();
  });

  function clearMarkers() { while (markers.length) markers.pop().remove(); }

  function parseLL(s) {
    const m = String(s || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  }

  function placeEndpoints(from, to) {
    clearMarkers();
    const a = from || parseLL(fromInput.value), b = to || parseLL(toInput.value);
    if (a) markers.push(new maplibregl.Marker({ color: '#0f172a' }).setLngLat([a.lng, a.lat]).setPopup(new maplibregl.Popup().setText('Start')).addTo(map));
    if (b) markers.push(new maplibregl.Marker({ color: '#10b981' }).setLngLat([b.lng, b.lat]).setPopup(new maplibregl.Popup().setText('Destination')).addTo(map));
  }

  document.getElementById('use-location').addEventListener('click', () => {
    if (!navigator.geolocation) { statusEl.textContent = 'Location is not available in this browser.'; return; }
    statusEl.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => { fromInput.value = `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`; statusEl.textContent = ''; placeEndpoints(); },
      () => { statusEl.textContent = 'Could not get your location. Type a place instead.'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  document.getElementById('swap-btn').addEventListener('click', () => {
    [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
    placeEndpoints();
  });

  document.getElementById('toggle-risk').addEventListener('change', async (e) => {
    if (!map.getLayer('risk-fill')) return;
    if (e.target.checked && !riskLoaded) {
      try { const g = await api('/api/risk/grid?minLevel=medium'); map.getSource('risk').setData({ type: 'FeatureCollection', features: g.features }); riskLoaded = true; }
      catch (err) { statusEl.textContent = `Risk layer unavailable: ${err.message}`; }
    }
    map.setLayoutProperty('risk-fill', 'visibility', e.target.checked ? 'visible' : 'none');
  });

  document.getElementById('route-form').addEventListener('submit', (e) => { e.preventDefault(); findRoute(); });

  async function findRoute() {
    const from = fromInput.value.trim(), to = toInput.value.trim();
    if (!from || !to) return;
    btn.disabled = true;
    statusEl.textContent = 'Finding routes and checking accident history along each…';
    resultsEl.replaceChildren();
    try {
      const r = await api(`/api/routes/safe?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      lastResult = r;
      history.replaceState(null, '', `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      statusEl.textContent = '';
      placeEndpoints(r.from, r.to);
      renderResults(r);
      selectRoute(r.routes.find(x => x.recommended)?.id ?? r.routes[0].id, true);
    } catch (e) {
      statusEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function renderResults(r) {
    const cards = r.routes.map((rt, i) => {
      const label = rt.recommended ? 'Recommended' : rt.fastest ? 'Fastest' : `Alternative ${i}`;
      const color = rt.safetyScore >= 70 ? '#059669' : rt.safetyScore >= 40 ? '#d97706' : '#dc2626';
      return el('div', { class: `route-card${rt.recommended ? ' recommended' : ''}`, 'data-id': String(rt.id), tabindex: '0', role: 'button', onclick: () => selectRoute(rt.id), onkeydown: (e) => { if (e.key === 'Enter') selectRoute(rt.id); } }, [
        el('div', { class: 'route-card-top' }, [
          el('strong', { text: `${label}${rt.fastest && rt.recommended ? ' · also fastest' : ''}` }),
          el('span', { class: 'route-score', style: `color:${color}` }, [String(rt.safetyScore), el('small', { text: ' /100 safety' })]),
        ]),
        el('div', { class: 'route-stats' }, [
          el('span', { text: `${Math.round(rt.durationMin)} min` }),
          el('span', { text: `${rt.distanceKm} km` }),
          el('span', { text: `${rt.incidentsNearby} past incidents within ${r.bufferM} m` }),
          el('span', { text: `${rt.bySeverity.fatal} fatal · ${rt.bySeverity.serious} serious · ${rt.bySeverity.minor} minor` }),
          rt.hotspotCellsCrossed ? el('span', { text: `${rt.hotspotCellsCrossed} predicted hotspot cell(s)` }) : null,
        ]),
        rt.hotspots.length ? el('div', { class: 'route-hint', style: 'margin-top:4px', text: `Hotspots on the way: ${rt.hotspots.map(h => h.name).filter(Boolean).join(', ') || 'unnamed'}` }) : null,
      ]);
    });
    resultsEl.replaceChildren(el('p', { class: 'route-summary', text: r.summary }), ...cards);
    document.getElementById('route-disclaimer').textContent = `${r.disclaimer} Routing: ${r.sources.routing}. Places: ${r.sources.geocoding}. ${r.sources.incidents} incidents considered.`;
  }

  function selectRoute(id, fit = false) {
    if (!lastResult) return;
    activeId = Number(id);
    const feats = lastResult.routes.map(rt => ({ type: 'Feature', geometry: rt.geometry, properties: { id: rt.id, active: rt.id === activeId, recommended: rt.recommended } }));
    map.getSource('routes').setData({ type: 'FeatureCollection', features: feats });
    const rt = lastResult.routes.find(x => x.id === activeId);
    map.getSource('incidents').setData({ type: 'FeatureCollection', features: rt.incidents.map(i => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lng, i.lat] }, properties: i })) });
    document.querySelectorAll('.route-card').forEach(c => c.classList.toggle('active', Number(c.dataset.id) === activeId));
    if (fit) {
      const b = new maplibregl.LngLatBounds();
      lastResult.routes.forEach(r => r.geometry.coordinates.forEach(c => b.extend(c)));
      map.fitBounds(b, { padding: 50, duration: 600 });
    }
  }
})();

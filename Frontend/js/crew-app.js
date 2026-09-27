/**
 * crew-app.js — ambulance crew page opened from the crew link a hospital
 * shares (?id=<alert>&t=<crew token>). Shares live GPS, updates status,
 * navigates to the scene and back to the hospital.
 */
(function () {
  'use strict';
  const E = window.BATE;
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const id = qs.get('id'), token = qs.get('t');
  const base = `/api/crew/${encodeURIComponent(id || '')}`;
  const tq = `token=${encodeURIComponent(token || '')}`;

  let alert = null, map = null, layers = {}, routeLine = null, lastRouteAt = 0;
  let watchId = null, lastSent = null, wakeLock = null;

  if (!id || !token) {
    $('banner').className = 'status-banner status-banner--danger';
    $('banner').innerHTML = '<h1>Crew link incomplete</h1><p>Ask the hospital to share the link again.</p>';
    return;
  }

  const NEXT = {
    accepted: [{ s: 'dispatched', label: 'Ambulance has left', cls: 'btn-next' }],
    dispatched: [{ s: 'on_scene', label: 'Arrived at scene', cls: 'btn-next' }],
    on_scene: [
      { s: 'transporting', label: 'Patient on board → hospital', cls: 'btn-next' },
      { s: 'closed', label: 'Close: treated on scene', outcome: 'treated_on_scene', cls: 'btn-outline' },
      { s: 'closed', label: 'Close: patient not found', outcome: 'not_found', cls: 'btn-outline' },
    ],
    transporting: [{ s: 'closed', label: 'Handed over at hospital', outcome: 'handed_over', cls: 'btn-next' }],
  };

  function render(a) {
    alert = a;
    const amb = a.ambulance || {};
    const b = $('banner');
    const title = { accepted: 'Case accepted — head out', dispatched: 'Driving to scene', on_scene: 'At the scene', transporting: `To ${a.hospital ? a.hospital.name : 'hospital'}`, closed: 'Case closed', cancelled: 'Cancelled by the reporter', new: 'Case released' }[a.status];
    const cls = { closed: 'muted', cancelled: 'danger', new: 'muted', on_scene: 'ok' }[a.status] || 'moving';
    b.className = 'status-banner status-banner--' + cls;
    b.innerHTML = `${a.is_drill ? '<span class="dbadge">Drill</span>' : ''}<h1>${E.esc(title)}</h1>
      ${amb.eta_min != null && ['dispatched', 'transporting'].includes(a.status) ? `<div class="big-eta">${E.esc(E.eta(amb.eta_min, amb.eta_source))}</div>` : ''}
      <p>${E.esc(a.cancel_reason || (a.status === 'closed' ? E.OUTCOME[a.close_outcome] || '' : ''))}</p>`;

    $('scene-badges').innerHTML = `<span class="pbadge pbadge--${a.priority}">${E.esc(E.PRIORITY[a.priority])}</span>${a.report_count > 1 ? `<span class="lbadge lbadge--general">${a.report_count} reports</span>` : ''}`;
    $('scene-addr').textContent = a.address || `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`;
    $('scene-triage').textContent = a.triage_summary + (a.vision ? ` · photo looks ${a.vision.severity}` : '');
    $('scene-note').textContent = a.note || '';
    $('scene-actions').innerHTML = `
      <a class="btn btn-next btn-sm" href="${E.directions(a.lat, a.lng)}" target="_blank" rel="noopener">Navigate to scene</a>
      ${a.reporter_phone ? `<a class="btn btn-outline btn-sm" href="${E.telHref(a.reporter_phone)}">Call bystander</a>` : ''}`;

    const acts = NEXT[a.status] || [];
    $('status-actions').innerHTML = acts.length
      ? acts.map(x => `<button type="button" class="btn ${x.cls}" data-s="${x.s}" data-o="${x.outcome || ''}">${E.esc(x.label)}</button>`).join('')
      : '<p class="hint">No further actions.</p>';

    const h = a.hospital;
    $('dest').innerHTML = h ? `<div class="hrow"><div class="hrow-main"><div class="hrow-name">${E.esc(h.name)}</div><div class="hrow-meta">${E.esc(h.address || '')}</div></div>
      ${h.phone ? `<a class="icon-btn icon-btn--call" href="${E.telHref(h.phone)}">Call</a>` : ''}
      <a class="icon-btn" href="${E.directions(h.lat, h.lng)}" target="_blank" rel="noopener">Navigate</a></div>` : '';

    if (['closed', 'cancelled', 'new'].includes(a.status)) stopSharing();
    $('share-btn').disabled = !['accepted', 'dispatched', 'on_scene', 'transporting'].includes(a.status);
    renderMap(a);
  }

  function renderMap(a) {
    if (!window.L) return;
    if (!map) map = E.map($('crew-map'), [a.lat, a.lng], 14);
    const set = (k, ll, icon) => {
      if (!ll) { if (layers[k]) { map.removeLayer(layers[k]); delete layers[k]; } return; }
      if (!layers[k]) layers[k] = L.marker(ll, { icon }).addTo(map); else layers[k].setLatLng(ll);
    };
    set('scene', [a.lat, a.lng], E.icons.scene());
    set('hospital', a.hospital && a.hospital.lat != null ? [a.hospital.lat, a.hospital.lng] : null, E.icons.hospital());
    const amb = a.ambulance;
    set('me', amb && amb.lat != null ? [amb.lat, amb.lng] : null, E.icons.ambulance());
    if (!map._fitted) { const pts = Object.values(layers).map(m => m.getLatLng()); if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.2)); map._fitted = true; }
    if (Date.now() - lastRouteAt > 30000 && ['accepted', 'dispatched', 'transporting'].includes(a.status)) {
      lastRouteAt = Date.now();
      E.api(`${base}/route?${tq}`).then(r => {
        if (!r.coordinates) return;
        const ll = r.coordinates.map(c => [c[1], c[0]]);
        if (routeLine) routeLine.setLatLngs(ll); else routeLine = L.polyline(ll, { color: '#2563eb', weight: 5, opacity: 0.7 }).addTo(map);
      }).catch(() => {});
    }
  }

  // ── Status buttons ─────────────────────────────────────────────────────
  $('status-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-s]');
    if (!btn) return;
    btn.disabled = true;
    try {
      render(await E.api(`${base}/status?${tq}`, { method: 'POST', json: { status: btn.dataset.s, outcome: btn.dataset.o || undefined } }));
      E.toast('Status updated');
    } catch (err) { E.toast(err.message, 'error'); btn.disabled = false; }
  });

  // ── Location sharing ───────────────────────────────────────────────────
  async function send(pos) {
    const { latitude, longitude, accuracy, heading, speed } = pos.coords;
    const now = Date.now();
    if (lastSent && now - lastSent.at < 5000) return;
    lastSent = { at: now };
    try {
      const r = await E.api(`${base}/location?${tq}`, { method: 'POST', json: { lat: latitude, lng: longitude, accuracy, heading, speed } });
      $('share-text').innerHTML = `<span class="sharing-on">● Sharing</span> · ±${Math.round(accuracy)} m · sent ${E.clock(new Date())}${r.eta_min != null ? ` · ETA ${E.esc(E.eta(r.eta_min, r.eta_source))}` : ''}`;
    } catch (err) {
      $('share-text').textContent = 'Could not send location: ' + err.message;
      if (err.status === 409 || err.status === 404) stopSharing();
    }
  }

  async function startSharing() {
    if (!navigator.geolocation) { E.toast('Location is not available on this device.', 'error'); return; }
    watchId = navigator.geolocation.watchPosition(send, (err) => {
      $('share-text').textContent = err.code === 1 ? 'Location permission denied. Allow location for this site to share it.' : 'Waiting for GPS…';
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
    $('share-btn').textContent = 'Stop sharing location';
  }
  function stopSharing() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    $('share-btn').textContent = 'Start sharing location';
  }
  $('share-btn').addEventListener('click', () => (watchId == null ? startSharing() : stopSharing()));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && watchId != null && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } }
  });

  // ── Data ───────────────────────────────────────────────────────────────
  E.api(`${base}?${tq}`).then(render).catch(err => {
    $('banner').className = 'status-banner status-banner--danger';
    $('banner').innerHTML = `<h1>${err.status === 404 ? 'Crew link not valid' : 'Could not load the case'}</h1><p>${E.esc(err.message)}</p>`;
  });
  E.stream(`${base}/stream?${tq}`, { alert: render }, {
    onState: (s) => { $('live').className = 'live-pill live-pill--' + s; $('live').textContent = s === 'live' ? 'Live' : s === 'denied' ? 'Link invalid' : 'Reconnecting'; },
  });
}());

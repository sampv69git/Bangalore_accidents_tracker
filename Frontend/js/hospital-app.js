/**
 * hospital-app.js — Hospital directory + responder console.
 *
 * Everyone: searchable directory with emergency capability, live ER status and
 * "nearest by drive time".
 * Hospital accounts: live SOS console — accept / decline, move the case through
 * dispatched → on scene → transporting → closed, share ambulance location,
 * send a crew link, set ER status (accepting / busy / diverting).
 * Admins: control-room view of every alert, hospital-account linking and
 * record corrections.
 */
(function () {
  'use strict';
  const E = window.BATE;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  /* ── Nav ─────────────────────────────────────────────────────────────── */
  (function initNav() {
    const nav = $('main-nav');
    if (nav) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
      window.addEventListener('scroll', onScroll);
      onScroll();
    }
    window.Auth?.updateNavAuth?.();
  })();

  /* ── Modal ───────────────────────────────────────────────────────────── */
  function openModal(title, html) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    $('modal').hidden = false;
    $('modal-close').focus();
  }
  function closeModal() {
    $('modal').hidden = true;
    $('modal-body').querySelectorAll('img[data-blob]').forEach(i => URL.revokeObjectURL(i.src));
    $('modal-body').innerHTML = '';
    if (location.hash.startsWith('#alert=')) history.replaceState(null, '', location.pathname + location.search);
  }
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  const levelBadge = (l) => (l ? `<span class="lbadge lbadge--${esc(l)}">${esc(E.LEVEL[l] || l)}</span>` : '');
  const erBadge = (s) => (s ? `<span class="erbadge erbadge--${esc(s)}">${esc(E.ER[s])}</span>` : '');

  /* ════════════════════════════════════════════════════════════════════════
     Directory
     ════════════════════════════════════════════════════════════════════════ */
  const dir = { q: '', level: '', offset: 0, limit: 60, total: 0, near: null, isAdmin: false, rows: new Map() };

  function hospitalCard(h) {
    const card = document.createElement('div');
    card.className = 'hospital-card';
    const phone = h.phone
      ? `<a class="hospital-phone" href="${E.telHref(h.phone)}">📞 ${esc(h.phone)}</a>`
      : '<span class="hospital-phone text-muted">📞 Phone unavailable</span>';
    card.innerHTML = `
      <div class="badge-row">${levelBadge(h.emergency_level)}${erBadge(h.er_status)}${h.verified ? '<span class="lbadge lbadge--general" title="Checked by an admin">✓ Verified</span>' : ''}</div>
      <h3 class="hospital-name">${esc(h.name || 'Unnamed hospital')}</h3>
      ${h.eta_min != null ? `<div class="eta-line">${esc(E.eta(h.eta_min, h.eta_source))} drive · ${esc(E.km(h.road_km || h.distance_km))}</div>` : h.distance_km != null ? `<div class="eta-line">${esc(E.km(h.distance_km))} away</div>` : ''}
      ${phone}
      <p class="hospital-address">${h.address ? '📍 ' + esc(h.address) : '<span class="text-muted">📍 Address unavailable</span>'}</p>
      ${h.er_status_note ? `<p class="hint">ER note: ${esc(h.er_status_note)} (${esc(E.ago(h.er_status_updated_at))})</p>` : ''}
      <div class="card-links">
        ${h.lat != null ? `<a class="btn btn-outline btn-sm" href="${E.directions(h.lat, h.lng)}" target="_blank" rel="noopener">Directions</a>` : ''}
        ${dir.isAdmin ? `<button type="button" class="btn btn-outline btn-sm" data-edit="${esc(h.id)}">Edit</button>` : ''}
      </div>`;
    return card;
  }

  function renderHospitals(list, append) {
    const container = $('hospital-list');
    if (!append) { container.innerHTML = ''; dir.rows.clear(); }
    if (!list.length && !append) { container.innerHTML = '<div class="list-state">No hospitals match your search.</div>'; return; }
    const frag = document.createDocumentFragment();
    list.forEach(h => { dir.rows.set(h.id, h); frag.appendChild(hospitalCard(h)); });
    container.appendChild(frag);
  }

  function renderStats(stats) {
    if (!stats) return;
    $('stat-total').textContent = (stats.total || 0).toLocaleString();
    $('stat-trauma').textContent = (stats.byLevel?.trauma || 0).toLocaleString();
    $('stat-emergency').textContent = (stats.byLevel?.emergency || 0).toLocaleString();
    $('stat-accepting').textContent = (stats.byErStatus?.accepting || 0).toLocaleString();
  }

  // Offline fallback: the bundled hospitals.json directory, used when the API is unreachable.
  let localHospitalsCache = null;
  async function getLocalHospitals() {
    if (localHospitalsCache) return localHospitalsCache;
    const res = await fetch('hospitals.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    localHospitalsCache = raw.map(h => {
      let lat = null, lng = null;
      const m = h.location && String(h.location).match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); }
      return { id: h.id, name: h.name, phone: h.phone || null, address: h.address || null, lat: h.lat ?? lat, lng: h.lng ?? lng };
    });
    return localHospitalsCache;
  }

  async function loadLocalHospitals(reset) {
    let list = await getLocalHospitals();
    if (dir.q) {
      const s = dir.q.toLowerCase();
      list = list.filter(h => [h.name, h.address, h.phone].some(v => v && v.toLowerCase().includes(s)));
    }
    const page = list.slice(dir.offset, dir.offset + dir.limit);
    dir.total = list.length;
    renderHospitals(page, !reset);
    dir.offset += page.length;
    const shown = Math.min(dir.offset, dir.total);
    $('results-info').textContent = dir.total ? `Showing ${shown} of ${dir.total.toLocaleString()} hospitals (offline directory)` : '';
    $('load-more-btn').hidden = shown >= dir.total;
  }

  async function loadHospitals(reset = true) {
    const listEl = $('hospital-list');
    const more = $('load-more-btn');
    more.hidden = true;
    if (dir.near) return loadNearMe();
    if (reset) { dir.offset = 0; listEl.innerHTML = '<div class="list-state">Loading hospitals…</div>'; }
    try {
      const qs = new URLSearchParams({ limit: String(dir.limit), offset: String(dir.offset) });
      if (dir.q) qs.set('q', dir.q);
      if (dir.level) qs.set('level', dir.level);
      const data = await E.api('/api/hospitals?' + qs);
      dir.total = data.total || 0;
      renderStats(data.stats);
      renderHospitals(data.hospitals || [], !reset);
      dir.offset += (data.hospitals || []).length;
      const shown = Math.min(dir.offset, dir.total);
      $('results-info').textContent = dir.total ? `Showing ${shown} of ${dir.total.toLocaleString()} hospitals` : '';
      more.hidden = shown >= dir.total;
    } catch (e) {
      console.error('Failed to load hospitals', e);
      try {
        await loadLocalHospitals(reset);
      } catch (_) {
        listEl.innerHTML = '<div class="list-state list-state--error">Failed to load hospitals. Is the API running?</div>';
      }
    }
  }

  async function loadNearMe() {
    const listEl = $('hospital-list');
    listEl.innerHTML = '<div class="list-state">Finding the quickest hospitals to reach…</div>';
    try {
      const emergencyOnly = dir.level !== 'none' && dir.level !== '';
      let list = await E.api(`/api/hospitals/near?lat=${dir.near.lat}&lng=${dir.near.lng}&limit=24&eta=1${emergencyOnly || dir.level === '' ? '&emergency=1' : ''}`);
      if (dir.level && dir.level !== 'dispatchable') list = list.filter(h => h.emergency_level === dir.level);
      if (dir.q) { const s = dir.q.toLowerCase(); list = list.filter(h => [h.name, h.address, h.phone].some(v => v && v.toLowerCase().includes(s))); }
      renderHospitals(list, false);
      $('results-info').textContent = `${list.length} emergency-capable hospitals nearest to you by drive time (traffic-adjusted estimate)`;
    } catch (e) {
      listEl.innerHTML = `<div class="list-state list-state--error">${esc(e.message)}</div>`;
    }
  }

  $('near-btn').addEventListener('click', () => {
    if (dir.near) { dir.near = null; $('near-btn').textContent = '📍 Nearest by drive time'; loadHospitals(true); return; }
    if (!navigator.geolocation) { E.toast('Location is not available on this device.', 'error'); return; }
    $('near-btn').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition((pos) => {
      dir.near = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $('near-btn').textContent = '✕ Show all hospitals';
      loadNearMe();
    }, () => { $('near-btn').textContent = '📍 Nearest by drive time'; E.toast('Could not get your location.', 'error'); }, { enableHighAccuracy: true, timeout: 12000 });
  });

  let searchTimer = null;
  $('hospital-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { dir.q = e.target.value.trim(); loadHospitals(true); }, 250);
  });
  $('level-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('level-filter').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
    dir.level = chip.dataset.level;
    loadHospitals(true);
  });
  $('load-more-btn').addEventListener('click', () => loadHospitals(false));
  $('refresh-btn').addEventListener('click', () => { loadHospitals(true); if (con.me?.isResponder) loadAlerts(); });

  /* ── Admin: edit a hospital record ───────────────────────────────────── */
  $('hospital-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;
    const h = dir.rows.get(btn.dataset.edit);
    if (!h) return;
    openModal(`Edit ${h.name}`, `
      <form id="edit-form">
        <div class="form-row"><label for="ed-level">Emergency capability</label>
          <select id="ed-level" class="form-control">${['trauma', 'emergency', 'general', 'none'].map(l => `<option value="${l}" ${l === h.emergency_level ? 'selected' : ''}>${esc(E.LEVEL[l])}</option>`).join('')}</select>
          <span class="hint">Currently from: ${esc(h.level_source || 'unknown')}</span></div>
        <div class="form-row"><label for="ed-phone">Emergency phone</label><input id="ed-phone" class="form-control" value="${esc(h.phone || '')}"></div>
        <div class="form-row"><label for="ed-email">Alert email</label><input id="ed-email" type="email" class="form-control" placeholder="er@hospital.example"></div>
        <div class="form-row"><label for="ed-webhook">Alert webhook (https)</label><input id="ed-webhook" class="form-control" placeholder="https://…"></div>
        <label class="check-row" style="margin-bottom:var(--space-md);"><input id="ed-verified" type="checkbox" ${h.verified ? 'checked' : ''}> Verified (re-seeding will not overwrite this record)</label>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>`);
    $('edit-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = { emergency_level: $('ed-level').value, phone: $('ed-phone').value.trim() || null, verified: $('ed-verified').checked };
      if ($('ed-email').value.trim()) body.email = $('ed-email').value.trim();
      if ($('ed-webhook').value.trim()) body.webhook_url = $('ed-webhook').value.trim();
      try {
        await E.api(`/api/admin/hospitals/${encodeURIComponent(h.id)}`, { method: 'PATCH', json: body, auth: true });
        E.toast('Hospital updated');
        closeModal();
        loadHospitals(true);
      } catch (err) { E.toast(err.message, 'error'); }
    });
  });

  /* ════════════════════════════════════════════════════════════════════════
     Responder console
     ════════════════════════════════════════════════════════════════════════ */
  const con = {
    me: null, alerts: new Map(), cards: new Map(), tab: 'incoming', scope: 'mine', live: 'connecting',
    stream: null, known: new Set(), sound: localStorage.getItem('bat.consoleSound') === '1',
    sharing: null, photoCache: new Map(), unread: 0, firstLoad: true,
  };
  const OPEN = ['accepted', 'dispatched', 'on_scene', 'transporting'];
  const NEXT = {
    accepted: [{ s: 'dispatched', label: 'Ambulance dispatched' }],
    dispatched: [{ s: 'on_scene', label: 'Arrived on scene' }],
    on_scene: [{ s: 'transporting', label: 'Patient on board' }, { s: 'closed', label: 'Close — treated on scene', outcome: 'treated_on_scene', secondary: true }],
    transporting: [{ s: 'closed', label: 'Handed over — close', outcome: 'handed_over' }],
  };

  function category(a) {
    if (a.status === 'new') return 'incoming';
    if (OPEN.includes(a.status) && (a.accepted_by_me || con.me.isAdmin)) return 'active';
    return 'recent';
  }

  function consoleShell() {
    const me = con.me;
    const h = me.hospital;
    const title = h ? esc(h.name) : me.isAdmin ? 'Control room' : 'Emergency console';
    return `
      <section class="console" aria-labelledby="console-title">
        <div class="console-head">
          <div>
            <span class="page-eyebrow">Responder console</span>
            <h2 id="console-title">${title}</h2>
            <div class="console-meta">${h ? `${levelBadge(h.emergency_level)} · signed in as ${esc(me.user.email || '')}` : me.isAdmin ? 'Admin — every alert in the city' : ''}</div>
          </div>
          <div class="filter-row" style="margin:0;">
            <span class="live-pill" id="live-pill">Connecting</span>
            <button type="button" class="btn btn-outline btn-sm" id="sound-btn">${con.sound ? '🔔 Alerts on' : '🔕 Enable alert sound'}</button>
            ${me.isAdmin && h ? `<div class="seg" id="scope-seg"><button type="button" data-scope="mine" aria-pressed="true">My hospital</button><button type="button" data-scope="all" aria-pressed="false">All</button></div>` : ''}
          </div>
        </div>
        ${h ? `
          <div class="filter-row" style="margin-bottom:var(--space-md);">
            <strong style="font-size:var(--font-size-sm);">ER status</strong>
            <div class="seg" id="er-seg" role="group" aria-label="ER status">
              ${['accepting', 'busy', 'diverting', 'unknown'].map(v => `<button type="button" data-v="${v}" aria-pressed="${(h.er_status || 'unknown') === v}">${v === 'unknown' ? 'Not set' : esc(v[0].toUpperCase() + v.slice(1))}</button>`).join('')}
            </div>
            <input id="er-note" class="form-control" style="max-width:280px;min-height:40px;" maxlength="140" placeholder="Note, e.g. CT scanner down" value="${esc(h.er_status_note || '')}" aria-label="ER status note">
            <span class="hint">Diverting hospitals are skipped when alerts are routed.</span>
          </div>` : ''}
        ${!h && !me.isAdmin ? `<div class="notice notice--warn">Your account has the hospital role but is not linked to a hospital yet. Ask an admin to link it — until then you will not receive alerts.</div>` : ''}
        <div class="console-tabs" role="tablist">
          <button type="button" role="tab" data-tab="incoming" aria-selected="true">Incoming <span class="count" id="count-incoming">0</span></button>
          <button type="button" role="tab" data-tab="active" aria-selected="false">Active cases <span class="count" id="count-active">0</span></button>
          <button type="button" role="tab" data-tab="recent" aria-selected="false">Recent <span class="count" id="count-recent">0</span></button>
        </div>
        <div class="case-list" id="case-list"><div class="list-state">Loading alerts…</div></div>
        ${me.isAdmin ? adminShell() : ''}
      </section>`;
  }

  function setLive(state) {
    con.live = state;
    const el = $('live-pill');
    if (!el) return;
    el.className = 'live-pill live-pill--' + state;
    el.textContent = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : state === 'denied' ? 'Signed out' : 'Connecting';
  }

  /* ── Case cards ──────────────────────────────────────────────────────── */
  function caseFacts(a) {
    const f = [];
    if (a.my_target) f.push(`<span>Notified in <strong>round ${a.my_target.round || '—'}</strong>${a.my_target.eta_min != null ? ` · <strong>${esc(E.eta(a.my_target.eta_min, a.my_target.eta_source))}</strong> from you` : ''}</span>`);
    else if (a.distance_km_from_me != null) f.push(`<span><strong>${esc(E.km(a.distance_km_from_me))}</strong> from you (nearby, not notified)</span>`);
    if (a.hospitals_notified) f.push(`<span>${a.hospitals_notified} hospitals alerted</span>`);
    if (a.report_count > 1) f.push(`<span><strong>${a.report_count}</strong> bystander reports</span>`);
    if (a.photo_count) f.push(`<span>${a.photo_count} photo${a.photo_count > 1 ? 's' : ''}</span>`);
    if (a.vision) f.push(`<span>Photo looks <strong>${esc(a.vision.severity)}</strong></span>`);
    if (a.ambulance && a.ambulance.eta_min != null && ['accepted', 'dispatched', 'transporting'].includes(a.status)) f.push(`<span>Ambulance ETA <strong>${esc(E.eta(a.ambulance.eta_min, a.ambulance.eta_source))}</strong></span>`);
    if (a.escalation.exhausted && a.status === 'new') f.push('<span style="color:#b91c1c;"><strong>No hospital accepted in time</strong></span>');
    return f.join('');
  }

  function caseActions(a) {
    const b = [];
    if (a.status === 'new' && con.me.hospital) {
      b.push(`<button type="button" class="btn btn-accept" data-act="accept">Accept — send ambulance</button>`);
      if (a.my_target && a.my_target.response === 'pending') {
        b.push(`<select class="form-control" data-decline-reason style="max-width:220px;min-height:40px;" aria-label="Decline reason">
          <option>No ambulance available</option><option>No trauma / ICU bed</option><option>Too far for us</option><option>Other</option></select>
          <button type="button" class="btn btn-outline btn-sm" data-act="decline">Decline</button>`);
      }
    }
    if (a.accepted_by_me && OPEN.includes(a.status)) {
      (NEXT[a.status] || []).forEach(n => b.push(`<button type="button" class="btn ${n.secondary ? 'btn-outline btn-sm' : 'btn-next'}" data-act="status" data-s="${n.s}" data-o="${n.outcome || ''}">${esc(n.label)}</button>`));
      if (['accepted', 'dispatched', 'transporting'].includes(a.status)) {
        const on = con.sharing && con.sharing.id === a.id;
        b.push(`<button type="button" class="btn btn-outline btn-sm" data-act="share">${on ? '■ Stop sharing location' : '📡 Share this device as ambulance'}</button>`);
      }
      b.push(`<button type="button" class="btn btn-outline btn-sm" data-act="crew">Crew link</button>`);
      if (a.reporter_phone) b.push(`<a class="btn btn-outline btn-sm" href="${E.telHref(a.reporter_phone)}">Call bystander</a>`);
      if (['accepted', 'dispatched'].includes(a.status)) b.push(`<button type="button" class="btn btn-outline btn-sm" data-act="release">Hand back</button>`);
    }
    if (con.me.isAdmin && ['new', ...OPEN].includes(a.status)) b.push(`<button type="button" class="btn btn-outline btn-sm" data-act="cancel">Cancel (admin)</button>`);
    b.push(`<a class="btn btn-outline btn-sm" href="${E.directions(a.lat, a.lng)}" target="_blank" rel="noopener">Directions</a>`);
    b.push(`<button type="button" class="btn btn-outline btn-sm" data-act="details">Details</button>`);
    return b.join('');
  }

  function caseBody(a) {
    const taken = a.accepted_hospital_name && !a.accepted_by_me;
    const statusText = a.status === 'new' ? 'Waiting for a hospital' : taken && OPEN.includes(a.status) ? `Taken by ${a.accepted_hospital_name}` : E.STATUS[a.status];
    return `
      <div class="case-top">
        <span class="pbadge pbadge--${esc(a.priority)}">${esc(E.PRIORITY[a.priority] || a.priority)}</span>
        ${a.is_drill ? '<span class="dbadge">Drill</span>' : ''}
        <span class="lbadge lbadge--general">${esc(statusText)}</span>
        ${a.accepted_by_me ? '<span class="erbadge erbadge--accepting">Your case</span>' : ''}
        <span class="case-time" title="${esc(new Date(a.created_at).toLocaleString())}">${esc(E.ago(a.created_at))}</span>
      </div>
      <div class="case-addr">${esc(a.address || `${Number(a.lat).toFixed(5)}, ${Number(a.lng).toFixed(5)}`)}</div>
      <div class="case-triage">${esc(a.triage_summary)}</div>
      ${a.note ? `<div class="case-note">${esc(a.note)}</div>` : ''}
      ${a.vision && a.vision.description ? `<div class="case-note"><em>Photo: ${esc(a.vision.description)}</em></div>` : ''}
      <div class="case-facts">${caseFacts(a)}</div>
      <div class="case-actions">${caseActions(a)}</div>`;
  }

  async function photoUrl(a, index) {
    const key = `${a.id}:${index == null ? 'last' : index}:${a.photo_count}`;
    if (con.photoCache.has(key)) return con.photoCache.get(key);
    const t = await E.getToken();
    const res = await fetch(`${E.API}/api/hospital/alerts/${encodeURIComponent(a.id)}/photo${index != null ? '?n=' + index : ''}`, { headers: { Authorization: 'Bearer ' + t } });
    if (!res.ok) throw new Error('photo');
    const url = URL.createObjectURL(await res.blob());
    con.photoCache.set(key, url);
    return url;
  }

  function ensureCard(a) {
    let card = con.cards.get(a.id);
    if (!card) {
      card = document.createElement('article');
      card.dataset.id = a.id;
      card.innerHTML = '<div class="case-media"></div><div class="case-body"></div>';
      con.cards.set(a.id, card);
      card._media = { map: null, marker: null, amb: null, photoKey: null };
    }
    card.className = `case-card case-card--${a.priority}${category(a) === 'recent' ? ' case-card--muted' : ''}`;
    card.querySelector('.case-body').innerHTML = caseBody(a);
    // Media is built once per card and only updated, so live updates don't flicker.
    const media = card.querySelector('.case-media');
    const m = card._media;
    if (window.L && !m.map) {
      const el = document.createElement('div');
      el.className = 'case-map';
      media.appendChild(el);
      requestAnimationFrame(() => {
        m.map = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false }).setView([a.lat, a.lng], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(m.map);
        m.marker = L.marker([a.lat, a.lng], { icon: E.icons.scene() }).addTo(m.map);
        updateAmb(a, m);
      });
    } else if (m.map) updateAmb(a, m);
    if (a.photo_count && m.photoKey !== `${a.photo_count}`) {
      m.photoKey = `${a.photo_count}`;
      photoUrl(a).then(url => {
        let img = media.querySelector('.case-photo');
        if (!img) { img = document.createElement('img'); img.className = 'case-photo'; img.alt = 'Scene photo'; img.dataset.act = 'details'; media.appendChild(img); }
        img.src = url;
      }).catch(() => {});
    }
    return card;
  }

  function updateAmb(a, m) {
    const amb = a.ambulance;
    const ll = amb && amb.lat != null && ['dispatched', 'transporting', 'on_scene'].includes(a.status) ? [amb.lat, amb.lng] : null;
    if (!ll) { if (m.amb) { m.map.removeLayer(m.amb); m.amb = null; } return; }
    if (!m.amb) m.amb = L.marker(ll, { icon: E.icons.ambulance() }).addTo(m.map); else m.amb.setLatLng(ll);
    m.map.fitBounds(L.latLngBounds([[a.lat, a.lng], ll]).pad(0.3), { maxZoom: 15 });
  }

  const PRIO_RANK = { critical: 0, urgent: 1, standard: 2 };
  function renderCases() {
    const list = $('case-list');
    if (!list) return;
    const groups = { incoming: [], active: [], recent: [] };
    for (const a of con.alerts.values()) groups[category(a)].push(a);
    groups.incoming.sort((x, y) => (PRIO_RANK[x.priority] - PRIO_RANK[y.priority]) || (!!y.my_target - !!x.my_target) || (new Date(y.created_at) - new Date(x.created_at)));
    groups.active.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    groups.recent.sort((x, y) => new Date(y.updated_at || y.created_at) - new Date(x.updated_at || x.created_at));
    ['incoming', 'active', 'recent'].forEach(k => { const c = $('count-' + k); if (c) c.textContent = groups[k].length; });
    const show = groups[con.tab];
    if (!show.length) {
      list.innerHTML = `<div class="list-state">${con.tab === 'incoming' ? 'No alerts waiting. New SOS alerts near your hospital appear here instantly.' : con.tab === 'active' ? 'No active cases.' : 'Nothing in the last 24 hours.'}</div>`;
      return;
    }
    const keep = new Set(show.map(a => a.id));
    [...list.children].forEach(ch => { if (!ch.dataset.id || !keep.has(ch.dataset.id)) ch.remove(); });
    show.forEach(a => list.appendChild(ensureCard(a)));
    requestAnimationFrame(() => show.forEach(a => con.cards.get(a.id)?._media.map?.invalidateSize()));
  }

  function upsert(a, { live = false } = {}) {
    const isNewIncoming = live && a.status === 'new' && !con.known.has(a.id);
    con.alerts.set(a.id, a);
    con.known.add(a.id);
    if (isNewIncoming) notifyIncoming(a);
    renderCases();
    if (isNewIncoming) con.cards.get(a.id)?.classList.add('case-card--fresh');
  }

  function notifyIncoming(a) {
    if (!con.me.hospital && !con.me.isAdmin) return;
    if (con.sound) E.beep(a.priority === 'critical' ? 5 : 3);
    if (document.hidden) {
      con.unread++;
      document.title = `(${con.unread}) 🚨 New SOS — BAT`;
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(`${E.PRIORITY[a.priority]} SOS — ${a.address || 'near you'}`, { body: a.triage_summary, tag: a.id, requireInteraction: a.priority === 'critical' });
          n.onclick = () => { window.focus(); openDetails(a.id); n.close(); };
        }
      } catch { /* notifications unavailable */ }
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { con.unread = 0; document.title = 'Hospitals & Emergency Response — Bangalore Accidents Tracker'; } });

  /* ── Data ────────────────────────────────────────────────────────────── */
  async function loadAlerts() {
    try {
      const list = await E.api('/api/hospital/alerts' + (con.scope === 'all' ? '?scope=all' : ''), { auth: true });
      const ids = new Set(list.map(a => a.id));
      for (const id of [...con.alerts.keys()]) if (!ids.has(id)) { con.alerts.delete(id); con.cards.get(id)?.remove(); con.cards.delete(id); }
      list.forEach(a => { con.alerts.set(a.id, a); con.known.add(a.id); });
      renderCases();
      if (con.firstLoad) {
        con.firstLoad = false;
        if (list.some(a => category(a) === 'active') && !list.some(a => a.status === 'new')) selectTab('active');
      }
    } catch (e) {
      if (e.status === 401) setLive('denied');
      const list = $('case-list');
      if (list && !con.alerts.size) list.innerHTML = `<div class="list-state list-state--error">${esc(e.message)}</div>`;
    }
  }

  function connect() {
    con.stream?.stop();
    con.stream = E.stream('/api/hospital/stream', {
      alert: (a) => {
        // Admins receive every alert; in "My hospital" scope keep the same ones the server would list.
        if (con.scope === 'mine' && con.me.isAdmin && con.me.hospital && !con.alerts.has(a.id)) {
          const relevant = a.my_target || a.accepted_by_me || (a.status === 'new' && a.distance_km_from_me != null && a.distance_km_from_me <= 15);
          if (!relevant) return;
        }
        upsert(a, { live: true });
      },
      gone: (d) => { con.alerts.delete(d.id); con.cards.get(d.id)?.remove(); con.cards.delete(d.id); renderCases(); },
      hospital: (h) => { con.me.hospital = h; },
    }, { auth: true, onState: (s) => { setLive(s); if (s === 'live') loadAlerts(); } });
  }

  function selectTab(tab) {
    con.tab = tab;
    document.querySelectorAll('.console-tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('case-list').innerHTML = '';
    renderCases();
  }

  /* ── Actions ─────────────────────────────────────────────────────────── */
  async function act(id, path, body) {
    const a = await E.api(`/api/hospital/alerts/${encodeURIComponent(id)}/${path}`, { method: 'POST', json: body || {}, auth: true });
    if (a && a.id && a.status) upsert(a);
    return a;
  }

  async function onCaseClick(e) {
    const el = e.target.closest('[data-act]');
    const card = e.target.closest('.case-card');
    if (!el || !card) return;
    const id = card.dataset.id;
    const a = con.alerts.get(id);
    const kind = el.dataset.act;
    if (el.tagName === 'BUTTON') el.disabled = true;
    try {
      if (kind === 'accept') {
        await act(id, 'accept');
        E.toast('Accepted — the reporter can see your hospital is responding.');
        selectTab('active');
      } else if (kind === 'decline') {
        await act(id, 'decline', { reason: card.querySelector('[data-decline-reason]')?.value });
        E.toast('Declined — the alert moves on to other hospitals.', 'warning');
      } else if (kind === 'status') {
        await act(id, 'status', { status: el.dataset.s, outcome: el.dataset.o || undefined });
        if (el.dataset.s === 'closed' || el.dataset.s === 'on_scene') stopSharing();
      } else if (kind === 'release') {
        const reason = prompt('Why are you handing this case back? It will be sent to other hospitals immediately.', 'No ambulance available');
        if (reason === null) return;
        stopSharing();
        await act(id, 'release', { reason });
        E.toast('Case handed back and re-dispatched.', 'warning');
      } else if (kind === 'cancel') {
        const reason = prompt('Cancel this alert for everyone? Reason:', 'Duplicate / test alert');
        if (reason === null) return;
        await act(id, 'cancel', { reason });
      } else if (kind === 'share') {
        if (con.sharing && con.sharing.id === id) stopSharing(); else startSharing(id);
        renderCases();
      } else if (kind === 'crew') {
        const r = await act(id, 'crew-link');
        const msg = `BAT ambulance job (${E.PRIORITY[a.priority]}): ${a.address || ''}\nOpen to navigate and share live location: ${r.url}`;
        openModal('Crew link', `
          <p>Send this link to the ambulance driver's phone. It lets them navigate, share live location and update status for <strong>this case only</strong>.</p>
          <input class="form-control" readonly value="${esc(r.url)}" id="crew-url" style="margin:var(--space-md) 0;">
          <div class="case-actions">
            <button type="button" class="btn btn-primary btn-sm" id="crew-copy">Copy link</button>
            <a class="btn btn-outline btn-sm" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Share on WhatsApp</a>
            <a class="btn btn-outline btn-sm" href="sms:?body=${encodeURIComponent(msg)}">Send SMS</a>
          </div>`);
        $('crew-copy').addEventListener('click', () => { navigator.clipboard?.writeText(r.url).then(() => E.toast('Copied')); });
      } else if (kind === 'details') {
        openDetails(id);
      }
    } catch (err) {
      E.toast(err.message, 'error');
      if (err.status === 409 || err.status === 404) loadAlerts();
    } finally {
      if (el.tagName === 'BUTTON' && document.body.contains(el)) el.disabled = false;
    }
  }

  async function openDetails(id) {
    history.replaceState(null, '', '#alert=' + encodeURIComponent(id));
    openModal('Alert details', '<div class="list-state">Loading…</div>');
    try {
      const a = await E.api(`/api/hospital/alerts/${encodeURIComponent(id)}`, { auth: true });
      upsert(a);
      const photos = Array.from({ length: a.photo_count || 0 }, (_, i) => i);
      $('modal-title').textContent = `${E.PRIORITY[a.priority]} — ${a.address || 'SOS alert'}`;
      $('modal-body').innerHTML = `
        <div class="badge-row" style="margin-bottom:var(--space-sm);">
          <span class="pbadge pbadge--${esc(a.priority)}">${esc(E.PRIORITY[a.priority])}</span>
          <span class="lbadge lbadge--general">${esc(E.STATUS[a.status])}</span>
          ${a.is_drill ? '<span class="dbadge">Drill</span>' : ''}
          ${a.accepted_hospital_name ? `<span class="lbadge lbadge--general">${esc(a.accepted_hospital_name)}</span>` : ''}
        </div>
        ${photos.length ? `<div class="photo-strip">${photos.map(i => `<img data-photo="${i}" alt="Scene photo ${i + 1}">`).join('')}</div>` : ''}
        <p class="case-triage">${esc(a.triage_summary)}</p>
        ${a.note ? `<p class="case-note">${esc(a.note)}</p>` : ''}
        <div class="case-facts" style="margin:var(--space-sm) 0 var(--space-md);">${caseFacts(a)}${a.reporter_phone ? `<span>Bystander: <a href="${E.telHref(a.reporter_phone)}">${esc(a.reporter_phone)}</a></span>` : ''}<span>Reported ${esc(new Date(a.created_at).toLocaleString())}</span></div>
        ${a.targets ? `<h4 style="font-size:var(--font-size-base);margin-bottom:6px;">Hospitals alerted</h4>
          <table class="data-table" style="margin-bottom:var(--space-md);"><thead><tr><th>Hospital</th><th class="num">Round</th><th class="num">ETA</th><th>Response</th></tr></thead><tbody>
          ${a.targets.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.round || '—'}</td><td class="num">${esc(E.eta(t.eta_min))}</td><td>${esc(t.response)}${t.decline_reason ? ' — ' + esc(t.decline_reason) : ''}</td></tr>`).join('')}
          </tbody></table>` : ''}
        <h4 style="font-size:var(--font-size-base);margin-bottom:6px;">Timeline</h4>
        <ul class="timeline">${(a.timeline || []).map(e => `<li><time>${esc(E.clock(e.at))}</time>${esc(E.timelineLabel(e))}</li>`).join('')}</ul>`;
      $('modal-body').querySelectorAll('img[data-photo]').forEach(img => {
        photoUrl(a, Number(img.dataset.photo)).then(u => { img.src = u; }).catch(() => img.remove());
      });
    } catch (err) {
      $('modal-body').innerHTML = `<div class="list-state list-state--error">${esc(err.message)}</div>`;
    }
  }

  /* ── Ambulance location from this device ─────────────────────────────── */
  function startSharing(id) {
    stopSharing();
    if (!navigator.geolocation) { E.toast('Location is not available on this device.', 'error'); return; }
    let last = 0;
    const watch = navigator.geolocation.watchPosition(async (pos) => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      try {
        await E.api(`/api/hospital/alerts/${encodeURIComponent(id)}/location`, { method: 'POST', auth: true, json: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, heading: pos.coords.heading, speed: pos.coords.speed } });
      } catch (e) { E.toast('Location not sent: ' + e.message, 'error'); if (e.status === 409) { stopSharing(); renderCases(); } }
    }, () => E.toast('Could not read this device\'s location.', 'error'), { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    con.sharing = { id, watch };
    E.toast('Sharing this device\'s location as the ambulance.');
  }
  function stopSharing() {
    if (con.sharing) navigator.geolocation.clearWatch(con.sharing.watch);
    con.sharing = null;
  }

  /* ── ER status ───────────────────────────────────────────────────────── */
  async function saveEr(status) {
    try {
      const h = await E.api('/api/hospital/me/status', { method: 'PATCH', auth: true, json: { er_status: status, note: $('er-note')?.value.trim() || null } });
      con.me.hospital = h;
      document.querySelectorAll('#er-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === (h.er_status || 'unknown'))));
      E.toast(status === 'diverting' ? 'Diverting — new alerts will skip your hospital.' : 'ER status updated');
    } catch (e) { E.toast(e.message, 'error'); }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Admin tools
     ════════════════════════════════════════════════════════════════════════ */
  function adminShell() {
    return `
      <div class="admin-panel">
        <h3 style="font-size:var(--font-size-lg);margin-bottom:var(--space-sm);">Admin</h3>
        <div class="admin-grid">
          <div>
            <h4 style="font-size:var(--font-size-base);margin-bottom:6px;">Link a hospital account</h4>
            <p class="hint" style="margin-bottom:var(--space-sm);">The person signs up normally, then you link their email to their hospital. This grants the hospital role.</p>
            <form id="link-form">
              <div class="form-row"><input id="link-email" type="email" class="form-control" placeholder="Staff email" required aria-label="Staff email"></div>
              <div class="form-row picker">
                <input id="link-hospital" class="form-control" placeholder="Search hospital…" autocomplete="off" aria-label="Hospital">
                <div class="picker-results" id="link-results" hidden></div>
              </div>
              <button class="btn btn-primary btn-sm" type="submit">Link account</button>
            </form>
          </div>
          <div>
            <h4 style="font-size:var(--font-size-base);margin-bottom:6px;">Linked accounts</h4>
            <ul class="linked-list" id="linked-list"><li class="hint">Loading…</li></ul>
            <div class="case-actions" style="margin-top:var(--space-md);">
              <button type="button" class="btn btn-outline btn-sm" id="cov-refresh">Recompute coverage map</button>
              <button type="button" class="btn btn-outline btn-sm" id="drill-clear">Delete drill alerts</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  async function loadLinks() {
    try {
      const rows = await E.api('/api/admin/hospital-users', { auth: true });
      $('linked-list').innerHTML = rows.length
        ? rows.map(u => `<li><span><strong>${esc(u.email || u.user_id)}</strong><br><span class="hint">${esc(u.hospital_name || u.hospital_id)}</span></span><button type="button" class="btn btn-outline btn-sm" data-unlink="${esc(u.user_id)}">Unlink</button></li>`).join('')
        : '<li class="hint">No hospital accounts linked yet.</li>';
    } catch (e) { $('linked-list').innerHTML = `<li class="hint">${esc(e.message)}</li>`; }
  }

  function initAdmin() {
    let picked = null, timer = null;
    $('link-hospital').addEventListener('input', (e) => {
      picked = null;
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (q.length < 2) { $('link-results').hidden = true; return; }
      timer = setTimeout(async () => {
        const data = await E.api('/api/hospitals?limit=8&level=dispatchable&q=' + encodeURIComponent(q)).catch(() => ({ hospitals: [] }));
        $('link-results').innerHTML = data.hospitals.map(h => `<button type="button" data-id="${esc(h.id)}" data-name="${esc(h.name)}">${esc(h.name)} <span class="hint">${esc(E.LEVEL[h.emergency_level] || '')}${h.address ? ' · ' + esc(h.address.slice(0, 40)) : ''}</span></button>`).join('') || '<div class="hint" style="padding:10px;">No match</div>';
        $('link-results').hidden = false;
      }, 200);
    });
    $('link-results').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      picked = b.dataset.id;
      $('link-hospital').value = b.dataset.name;
      $('link-results').hidden = true;
    });
    $('link-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!picked) { E.toast('Pick a hospital from the list.', 'warning'); return; }
      try {
        const r = await E.api('/api/admin/hospital-users', { method: 'POST', auth: true, json: { email: $('link-email').value.trim(), hospital_id: picked } });
        E.toast(`Linked to ${r.hospital_name}. They may need to sign out and in again.`);
        $('link-form').reset(); picked = null;
        loadLinks();
      } catch (err) { E.toast(err.message, 'error'); }
    });
    $('linked-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-unlink]');
      if (!b || !confirm('Unlink this account? It will stop receiving alerts.')) return;
      try { await E.api(`/api/admin/hospital-users/${encodeURIComponent(b.dataset.unlink)}`, { method: 'DELETE', auth: true }); loadLinks(); } catch (err) { E.toast(err.message, 'error'); }
    });
    $('cov-refresh').addEventListener('click', async () => {
      try { await E.api('/api/admin/coverage/refresh', { method: 'POST', auth: true }); E.toast('Coverage is being recomputed (about a minute).'); } catch (err) { E.toast(err.message, 'error'); }
    });
    $('drill-clear').addEventListener('click', async () => {
      if (!confirm('Delete all drill (simulated) alerts?')) return;
      try { const r = await E.api('/api/admin/emergency/drills/clear', { method: 'POST', auth: true }); E.toast(`Deleted ${r.deleted} drill alerts`); loadAlerts(); } catch (err) { E.toast(err.message, 'error'); }
    });
    loadLinks();
  }

  /* ── Console boot ────────────────────────────────────────────────────── */
  async function initConsole() {
    const session = await E.getSession();
    if (!session) return;
    let me;
    try { me = await E.api('/api/hospital/me', { auth: true }); } catch { return; }
    dir.isAdmin = !!me.isAdmin;
    if (dir.isAdmin && dir.rows.size) loadHospitals(true);
    if (!me.isResponder) return;
    con.me = me;
    $('console-root').innerHTML = consoleShell();
    $('case-list').addEventListener('click', onCaseClick);
    document.querySelectorAll('.console-tabs [role=tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    $('sound-btn').addEventListener('click', async () => {
      con.sound = !con.sound;
      localStorage.setItem('bat.consoleSound', con.sound ? '1' : '0');
      if (con.sound) {
        E.unlockAudio(); E.beep(1);
        try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* ignore */ }
      }
      $('sound-btn').textContent = con.sound ? '🔔 Alerts on' : '🔕 Enable alert sound';
    });
    document.addEventListener('click', () => { if (con.sound) E.unlockAudio(); }, { once: true });
    $('er-seg')?.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) saveEr(b.dataset.v); });
    $('er-note')?.addEventListener('change', () => saveEr(con.me.hospital?.er_status || 'unknown'));
    $('scope-seg')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-scope]');
      if (!b) return;
      con.scope = b.dataset.scope;
      $('scope-seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      loadAlerts();
    });
    if (me.isAdmin) { con.scope = me.hospital ? 'mine' : 'all'; initAdmin(); }
    await loadAlerts();
    connect();
    setInterval(loadAlerts, 60000); // safety net; live updates arrive over the stream
    setInterval(() => { if (con.tab === 'incoming') renderCases(); }, 30000); // refresh "x min ago"
    const m = location.hash.match(/^#alert=(.+)$/);
    if (m) openDetails(decodeURIComponent(m[1]));
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadHospitals(true);
    initConsole();
  });
}());

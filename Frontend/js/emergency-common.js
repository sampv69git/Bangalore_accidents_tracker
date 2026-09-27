/**
 * emergency-common.js — shared helpers for the SOS, tracking, crew, hospital
 * console and coverage pages. Exposes window.BATE.
 */
(function () {
  'use strict';

  const API = ((window.BAT_CONFIG && window.BAT_CONFIG.apiBase) || 'http://localhost:3000').replace(/\/$/, '');
  const LAST_SOS_KEY = 'bat.lastSos';
  const BLR = [12.9716, 77.5946];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const el = document.createElement('div');
    el.className = 'toast toast--' + (type || 'success');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.classList.add('toast--removing'); setTimeout(() => el.remove(), 300); }, 3500);
  }

  async function getSession() {
    for (let i = 0; i < 40 && !window.SupabaseAuthClient; i++) await new Promise(r => setTimeout(r, 50));
    try { return window.SupabaseAuthClient ? await window.SupabaseAuthClient.getSession() : null; } catch { return null; }
  }
  async function getToken() {
    const s = await getSession();
    return s ? s.access_token : null;
  }

  /** fetch JSON; throws Error with .status and .body on HTTP errors. */
  async function api(path, opts) {
    const o = Object.assign({ headers: {} }, opts || {});
    if (o.auth) {
      const t = await getToken();
      if (t) o.headers.Authorization = 'Bearer ' + t;
    }
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(API + path, { method: o.method || 'GET', headers: o.headers, body: o.body, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || ('HTTP ' + res.status));
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }

  /**
   * Server-Sent Events over fetch (so an Authorization header can be sent),
   * with automatic reconnect. handlers: { [event]: fn(data) }, onState(state).
   */
  function stream(path, handlers, { auth = false, onState = () => {} } = {}) {
    let stopped = false, ctrl = null, retry = 2000;
    async function connect() {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const headers = { Accept: 'text/event-stream' };
        if (auth) { const t = await getToken(); if (t) headers.Authorization = 'Bearer ' + t; }
        const res = await fetch(API + path, { headers, signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
        onState('live');
        retry = 2000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            let ev = 'message', data = '';
            chunk.split('\n').forEach(line => {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            });
            if (data && handlers[ev]) { try { handlers[ev](JSON.parse(data)); } catch (e) { console.error(e); } }
          }
        }
        throw new Error('stream ended');
      } catch (e) {
        if (stopped || e.name === 'AbortError') return;
        onState(e.status === 401 || e.status === 403 || e.status === 404 ? 'denied' : 'reconnecting');
        if (e.status === 401 || e.status === 403 || e.status === 404) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      }
    }
    connect();
    return { stop() { stopped = true; if (ctrl) ctrl.abort(); } };
  }

  // ── Formatting ──────────────────────────────────────────────────────────
  const STATUS = {
    new: 'Waiting for a hospital', accepted: 'Hospital accepted', dispatched: 'Ambulance on the way',
    on_scene: 'Ambulance at the scene', transporting: 'On the way to hospital', closed: 'Closed', cancelled: 'Cancelled',
  };
  const PRIORITY = { critical: 'Critical', urgent: 'Urgent', standard: 'Standard' };
  const LEVEL = { trauma: 'Trauma centre', emergency: '24×7 emergency', general: 'General hospital', none: 'Not for accidents' };
  const ER = { accepting: 'ER accepting', busy: 'ER busy', diverting: 'ER diverting' };
  const OUTCOME = { handed_over: 'Handed over at hospital', treated_on_scene: 'Treated on scene', refused_care: 'Refused care', not_found: 'Patient not found', other: 'Other' };
  const STEPS = ['new', 'accepted', 'dispatched', 'on_scene', 'transporting', 'closed'];

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }
  const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  function eta(min, source) {
    if (min == null) return '';
    const m = Math.max(1, Math.round(min));
    return (source === 'estimate' ? '≈ ' : '~') + m + ' min';
  }
  const km = (x) => (x == null ? '' : (x < 1 ? Math.round(x * 1000) + ' m' : (Math.round(x * 10) / 10) + ' km'));
  const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  const directions = (lat, lng) => 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=driving';

  function timelineLabel(e) {
    const d = e.data || {};
    switch (e.type) {
      case 'created': return 'SOS raised';
      case 'notified': return 'Alert sent to ' + (d.count || (d.hospitals || []).length || 'nearby') + ' hospitals';
      case 'escalated': return 'No answer yet — alerted ' + (d.count || (d.hospitals || []).length || 'more') + ' more hospitals (round ' + d.round + ')';
      case 'accepted': return (d.hospital || 'A hospital') + ' accepted';
      case 'declined': return (d.hospital || 'A hospital') + ' declined' + (d.reason ? ': ' + d.reason : '');
      case 'released': return 'Hospital handed the case back — finding another';
      case 'status': return (STATUS[d.status] || d.status) + (d.auto ? ' (location sharing started)' : '') + (d.outcome ? ' — ' + (OUTCOME[d.outcome] || d.outcome) : '');
      case 'tracking_started': return 'Live ambulance location started';
      case 'photo_added': return 'Photo added';
      case 'photo_assessed': return 'Photo reviewed — looks ' + d.severity;
      case 'merged_report': return 'Another bystander reported this crash';
      case 'reporter_update': return 'Reporter added details';
      case 'cancelled': return 'Cancelled' + (d.reason ? ': ' + d.reason : '');
      case 'escalation_exhausted': return 'No hospital accepted in time';
      case 'crew_link_issued': return 'Crew link created';
      default: return e.type.replace(/_/g, ' ');
    }
  }

  // ── Bystander first aid (standard lay-rescuer guidance) ─────────────────
  function firstAid(triage) {
    const t = triage || {};
    const tips = [
      { k: 'safety', title: 'Keep yourself safe', text: 'Switch on hazard lights, stay out of the traffic lane and ask others to slow traffic down.' },
    ];
    if (t.fire === 'yes') tips.push({ k: 'fire', title: 'Fire or fuel leak', text: 'Keep everyone well back. No smoking. Only switch off the ignition if it is safe. Move people only if the fire puts them in immediate danger.' });
    if (t.breathing === 'no') tips.push({ k: 'cpr', title: 'Not breathing', text: 'Call 108 now — the call-taker will guide you. Give hands-only CPR: push hard and fast in the centre of the chest, 100–120 times a minute, until help arrives.' });
    if (t.bleeding === 'yes') tips.push({ k: 'bleed', title: 'Heavy bleeding', text: 'Press firmly on the wound with a clean cloth and keep pressing. Add more cloth on top if it soaks through. Do not pull out anything stuck in the wound.' });
    if (t.conscious === 'no') tips.push({ k: 'airway', title: 'Unconscious', text: 'Check they are breathing. Keep the head and neck in line with the body. If they vomit, roll them onto their side together with helpers, keeping head and neck aligned.' });
    if (t.trapped === 'yes') tips.push({ k: 'trapped', title: 'Trapped in a vehicle', text: 'Do not try to pull them out unless there is fire. Talk to them and keep them still until rescuers arrive.' });
    tips.push(
      { k: 'move', title: "Don't move the injured", text: 'Unless they are in immediate danger, moving them can worsen neck or spine injuries.' },
      { k: 'helmet', title: "Don't remove a helmet", text: "Leave a rider's helmet on unless it is stopping them from breathing." },
      { k: 'comfort', title: 'Comfort and watch', text: 'Keep them warm and calm, talk to them, and give nothing to eat or drink. Note any change to tell the ambulance crew.' },
    );
    return tips;
  }

  // ── Maps (Leaflet — crew, hospital console, coverage) ───────────────────
  function pin(cls, html) {
    return window.L ? L.divIcon({ className: 'emg-pin ' + cls, html: html || '', iconSize: [30, 30], iconAnchor: [15, 15] }) : null;
  }
  const icons = {
    scene: () => pin('emg-pin--scene', '!'),
    hospital: () => pin('emg-pin--hospital', 'H'),
    ambulance: () => pin('emg-pin--ambulance', '🚑'),
  };
  function map(el, center, zoom) {
    const m = L.map(el, { zoomControl: true, attributionControl: true }).setView(center || BLR, zoom || 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
    return m;
  }

  // ── Maps (MapLibre GL — same basemap as the dashboard) ──────────────────
  // Used by the SOS and tracking pages. center is [lat, lng] like map() above.
  const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  function glMap(el, center, zoom) {
    const c = center || BLR;
    const m = new maplibregl.Map({
      container: el,
      style: MAP_STYLE,
      center: [c[1], c[0]],
      zoom: zoom || 12,
      // The map sits inside a scrolling page: one finger / plain wheel scrolls
      // the page, two fingers / Ctrl+wheel move the map.
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    return m;
  }
  /** Round pin element for a maplibregl.Marker: 'scene' | 'hospital' | 'ambulance'. */
  function glPin(kind, title) {
    const el = document.createElement('div');
    el.className = 'emg-pin emg-pin--' + kind;
    el.textContent = { scene: '!', hospital: 'H', ambulance: '🚑' }[kind] || '';
    if (title) el.title = title;
    return el;
  }

  // ── Alert sound / notifications (hospital console) ──────────────────────
  let audioCtx = null;
  function beep(times) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const n = times || 3;
      for (let i = 0; i < n; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.35);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + i * 0.35 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.35 + 0.28);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + i * 0.35); o.stop(audioCtx.currentTime + i * 0.35 + 0.3);
      }
    } catch { /* audio unavailable */ }
  }
  function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* ignore */ } }

  // ── Remember the reporter's last SOS so they can get back to tracking ───
  function rememberSos(id, token) { try { localStorage.setItem(LAST_SOS_KEY, JSON.stringify({ id, t: token, at: Date.now() })); } catch { /* storage off */ } }
  function lastSos(maxAgeH) {
    try {
      const v = JSON.parse(localStorage.getItem(LAST_SOS_KEY) || 'null');
      return v && Date.now() - v.at < (maxAgeH || 6) * 3600000 ? v : null;
    } catch { return null; }
  }
  function forgetSos() { try { localStorage.removeItem(LAST_SOS_KEY); } catch { /* ignore */ } }

  /** Shrink a camera photo before upload (saves mobile data; server re-encodes anyway). */
  async function shrinkImage(file, maxSide) {
    const side = maxSide || 1600;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.82));
    } catch { return file; }
  }

  window.BATE = {
    API, esc, toast, api, stream, getSession, getToken, STATUS, PRIORITY, LEVEL, ER, OUTCOME, STEPS,
    ago, clock, eta, km, telHref, directions, timelineLabel, firstAid, icons, map, glMap, glPin, beep, unlockAudio,
    rememberSos, lastSos, forgetSos, shrinkImage, BLR,
  };
}());

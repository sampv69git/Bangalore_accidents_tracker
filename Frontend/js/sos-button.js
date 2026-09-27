/**
 * sos-button.js — floating SOS button on every page. If this device has an
 * SOS in progress it becomes a shortcut back to live tracking instead.
 * Needs css/emergency.css.
 */
(function () {
  'use strict';
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (['emergency.html', 'track.html', 'crew.html'].includes(page)) return;

  function lastSos() {
    try {
      const v = JSON.parse(localStorage.getItem('bat.lastSos') || 'null');
      return v && Date.now() - v.at < 6 * 3600000 ? v : null;
    } catch { return null; }
  }

  function mount() {
    if (!document.querySelector('link[href$="emergency.css"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'css/emergency.css';
      document.head.appendChild(l);
    }
    const a = document.createElement('a');
    const active = lastSos();
    if (active) {
      a.href = `track.html?id=${encodeURIComponent(active.id)}&t=${encodeURIComponent(active.t)}`;
      a.className = 'sos-fab sos-fab--active';
      a.innerHTML = '🚑 <span>Your SOS<span class="sos-fab-sub"><br>View live status</span></span>';
      a.setAttribute('aria-label', 'Open live tracking for your SOS');
    } else {
      a.href = 'emergency.html';
      a.className = 'sos-fab';
      a.innerHTML = '🚨 SOS';
      a.setAttribute('aria-label', 'Emergency SOS — alert nearby hospitals about an accident');
      a.title = 'Accident happening now? Alert nearby hospitals';
    }
    document.body.appendChild(a);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
}());

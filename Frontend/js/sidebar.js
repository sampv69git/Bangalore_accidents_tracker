/**
 * sidebar.js — the app shell: on desktop a slim icon rail that opens over the
 * page while hovered or focused (and can be pinned open), and a slide-in
 * drawer with a top bar on small screens.
 *
 * This is the single source of truth for the site navigation. Include it as
 * a plain (non-deferred) script at the very top of <body>; it renders in
 * place before first paint. Needs css/sidebar.css. auth.js fills the
 * #nav-auth-links footer with the login / user card.
 */
(function () {
  'use strict';

  var NAV = [
    { section: 'Explore' },
    { href: 'index.html', label: 'Home', icon: 'home' },
    { href: 'dashboard.html', label: 'Dashboard', icon: 'dashboard' },
    { href: 'trends.html', label: 'Trends', icon: 'trends' },
    { section: 'Tools' },
    { href: 'ask.html', label: 'Ask BAT', icon: 'ask', badge: 'AI' },
    { href: 'safe-route.html', label: 'Safe Route', icon: 'route' },
    { href: 'hospital.html', label: 'Hospital', icon: 'hospital', also: ['coverage.html'] },
    { section: 'Contribute' },
    { href: 'report.html', label: 'Report Accident', icon: 'report' },
    { href: 'profile.html', label: 'My Profile', icon: 'user' },
    { section: 'Emergency' },
    { href: 'emergency.html', label: 'Emergency SOS', icon: 'siren', tone: 'danger', also: ['track.html'] }
  ];

  // Lucide-style 24×24 stroke icons.
  var ICONS = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    trends: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/><path d="M16 8h4v4"/>',
    ask: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    hospital: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8"/><path d="M8 12h8"/>',
    report: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    siren: '<path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.93 4.93.71.71"/>',
    menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevron: '<path d="m15 18-6-6 6-6"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'
  };

  function icon(name, cls) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"' + (cls ? ' class="' + cls + '"' : '') + '>' + ICONS[name] + '</svg>';
  }

  var PIN_KEY = 'bat.sidebarPinned';
  var MOBILE_QUERY = window.matchMedia('(max-width: 960px)');
  var root = document.documentElement;
  var page = (location.pathname.split('/').pop() || 'index.html').split('?')[0].toLowerCase();

  // Auto-hide (icon rail) unless the user pinned the sidebar open.
  var pinned = false;
  try { pinned = localStorage.getItem(PIN_KEY) === '1'; } catch (e) { /* storage blocked — auto-hide */ }
  if (!pinned) root.classList.add('appnav-collapsed');

  function renderLink(item) {
    var isActive = item.href === page || (item.also || []).indexOf(page) !== -1;
    var cls = 'app-sidebar-link' + (item.tone ? ' app-sidebar-link--' + item.tone : '') + (isActive ? ' active' : '');
    // aria-label: the visible label is display:none while the rail is closed.
    return '<a href="' + item.href + '" class="' + cls + '" aria-label="' + item.label + '"' +
      (isActive ? ' aria-current="page"' : '') + '>' +
      icon(item.icon) +
      '<span class="app-sidebar-label">' + item.label + '</span>' +
      (item.badge ? '<span class="app-sidebar-badge">' + item.badge + '</span>' : '') +
      (item.tone === 'danger' ? '<span class="app-sidebar-pulse" aria-hidden="true"></span>' : '') +
    '</a>';
  }

  var links = NAV.map(function (item) {
    return item.section
      ? '<p class="app-sidebar-section">' + item.section + '</p>'
      : renderLink(item);
  }).join('');

  var html =
    '<header class="app-topbar" id="app-topbar">' +
      '<button type="button" class="app-topbar-menu" id="app-nav-toggle" aria-controls="main-nav" aria-expanded="false" aria-label="Open menu">' + icon('menu') + '</button>' +
      '<a href="index.html" class="app-topbar-brand">' +
        '<img src="logo-mark.png" alt="" width="32" height="32">' +
        '<span><strong>BAT</strong><small>Bangalore Accidents Tracker</small></span>' +
      '</a>' +
    '</header>' +
    '<div class="app-sidebar-scrim" id="app-sidebar-scrim"></div>' +
    '<aside class="app-sidebar" id="main-nav" aria-label="Main navigation">' +
      '<div class="app-sidebar-head">' +
        '<a href="index.html" class="app-sidebar-brand" title="Bangalore Accidents Tracker">' +
          '<span class="app-sidebar-logo"><img src="logo-mark.png" alt="BAT logo" width="34" height="34"></span>' +
          '<span class="app-sidebar-brand-text"><strong>BAT</strong><small>Bangalore Accidents Tracker</small></span>' +
        '</a>' +
        '<button type="button" class="app-sidebar-close" id="app-nav-close" aria-label="Close menu">' + icon('close') + '</button>' +
      '</div>' +
      '<nav class="app-sidebar-nav" id="nav-links">' + links + '</nav>' +
      '<div class="app-sidebar-foot" id="nav-auth-links"></div>' +
      '<button type="button" class="app-sidebar-edge" id="app-nav-collapse">' + icon('pin', 'appnav-ic-pin') + icon('chevron', 'appnav-ic-hide') + '</button>' +
    '</aside>';

  var script = document.currentScript;
  if (script) script.insertAdjacentHTML('beforebegin', html);
  else document.body.insertAdjacentHTML('afterbegin', html);
  document.body.classList.add('has-appnav');

  var toggle = document.getElementById('app-nav-toggle');
  var closeBtn = document.getElementById('app-nav-close');
  var scrim = document.getElementById('app-sidebar-scrim');
  var collapseBtn = document.getElementById('app-nav-collapse');
  var topbar = document.getElementById('app-topbar');
  var sidebar = document.getElementById('main-nav');

  // ── Mobile drawer ──
  function setDrawer(open) {
    root.classList.toggle('appnav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      var current = sidebar.querySelector('.app-sidebar-link.active') || sidebar.querySelector('.app-sidebar-link');
      if (current) current.focus({ preventScroll: true });
    } else if (sidebar.contains(document.activeElement)) {
      toggle.focus({ preventScroll: true });
    }
  }
  toggle.addEventListener('click', function () { setDrawer(!root.classList.contains('appnav-open')); });
  closeBtn.addEventListener('click', function () { setDrawer(false); });
  scrim.addEventListener('click', function () { setDrawer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.classList.contains('appnav-open')) setDrawer(false);
  });
  MOBILE_QUERY.addEventListener('change', function (e) {
    if (!e.matches) setDrawer(false);
  });

  // ── Desktop auto-hide: the rail opens over the page on hover / focus ──
  var OPEN_DELAY = 120;   // ms of hover before opening, so passing the cursor over it doesn't flash it open
  var CLOSE_DELAY = 250;
  var peekTimer = null;

  function isAutoHide() { return root.classList.contains('appnav-collapsed') && !MOBILE_QUERY.matches; }
  function setPeek(open) {
    clearTimeout(peekTimer);
    sidebar.classList.toggle('is-peek', open && isAutoHide());
  }
  function peekLater(open, delay) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(function () { setPeek(open); }, delay);
  }
  sidebar.addEventListener('mouseenter', function () { if (isAutoHide()) peekLater(true, OPEN_DELAY); });
  sidebar.addEventListener('mouseleave', function () { peekLater(false, CLOSE_DELAY); });
  sidebar.addEventListener('focusin', function () { setPeek(true); });
  sidebar.addEventListener('focusout', function (e) {
    if (!sidebar.contains(e.relatedTarget) && !sidebar.matches(':hover')) setPeek(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !sidebar.classList.contains('is-peek')) return;
    setPeek(false);
    if (sidebar.contains(document.activeElement)) document.activeElement.blur();
  });
  MOBILE_QUERY.addEventListener('change', function () { setPeek(false); });

  // ── Pin open / back to auto-hide ──
  function syncPinLabel() {
    var text = root.classList.contains('appnav-collapsed') ? 'Keep sidebar open' : 'Auto-hide sidebar';
    collapseBtn.setAttribute('aria-label', text);
    collapseBtn.title = text;
  }
  syncPinLabel();
  collapseBtn.addEventListener('click', function () {
    var pin = root.classList.contains('appnav-collapsed');
    root.classList.toggle('appnav-collapsed', !pin);
    // Un-pinning happens with the pointer/focus on the sidebar: stay open until it leaves.
    sidebar.classList.toggle('is-peek', !pin);
    try { localStorage.setItem(PIN_KEY, pin ? '1' : '0'); } catch (e) { /* ignore */ }
    syncPinLabel();
    // Maps (MapLibre / Leaflet) size themselves on window resize; the content
    // area changes width here, so nudge them once the transition settles.
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 320);
  });

  // Elevate the mobile top bar once the page scrolls under it.
  function onScroll() { topbar.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}());

/**
 * i18n.js — English / Hindi / Kannada switcher.
 *
 * Translates the sidebar labels (keeping their icons) plus a small set of
 * headings and buttons. Page links and body copy are never rewritten.
 * The switcher is a globe item at the bottom of the sidebar; pages without
 * the sidebar (login) get a small floating picker in the bottom-left corner.
 */
(function () {
  'use strict';

  var STORE_KEY = 'bat-language';
  var ORDER = ['en', 'hi', 'kn'];

  var languages = {
    en: { label: 'English', nav: {}, phrases: {} },
    hi: {
      label: 'हिन्दी',
      nav: {
        'index.html': 'होम', 'dashboard.html': 'डैशबोर्ड', 'trends.html': 'रुझान', 'ask.html': 'BAT से पूछें',
        'safe-route.html': 'सुरक्षित मार्ग', 'hospital.html': 'अस्पताल', 'report.html': 'दुर्घटना रिपोर्ट करें',
        'civic.html': 'नागरिक कार्रवाई', 'profile.html': 'मेरी प्रोफ़ाइल', 'emergency.html': 'आपातकाल SOS'
      },
      phrases: {
        'Accident Map': 'दुर्घटना मानचित्र', 'Filters': 'फ़िल्टर', 'Apply': 'लागू करें', 'Reset': 'रीसेट',
        'Share this view': 'यह दृश्य साझा करें', 'Road risk outlook': 'सड़क जोखिम संकेत',
        'Report Accident': 'दुर्घटना रिपोर्ट करें', 'View Live Map': 'लाइव मानचित्र देखें',
        'Emergency SOS': 'आपातकाल SOS', 'Emergency assistance': 'आपातकालीन सहायता',
        'Call 112': '112 कॉल करें', 'Call 108 Ambulance': '108 एम्बुलेंस कॉल करें',
        'Civic Action Tracker': 'नागरिक कार्रवाई ट्रैकर', 'Flag a safety issue': 'सुरक्षा समस्या दर्ज करें',
        'Trends & Analytics': 'रुझान और विश्लेषण', 'My Profile': 'मेरी प्रोफ़ाइल'
      }
    },
    kn: {
      label: 'ಕನ್ನಡ',
      nav: {
        'index.html': 'ಮುಖಪುಟ', 'dashboard.html': 'ಡ್ಯಾಶ್‌ಬೋರ್ಡ್', 'trends.html': 'ಪ್ರವೃತ್ತಿಗಳು', 'ask.html': 'BAT ಕೇಳಿ',
        'safe-route.html': 'ಸುರಕ್ಷಿತ ಮಾರ್ಗ', 'hospital.html': 'ಆಸ್ಪತ್ರೆ', 'report.html': 'ಅಪಘಾತ ವರದಿ ಮಾಡಿ',
        'civic.html': 'ನಾಗರಿಕ ಕ್ರಮ', 'profile.html': 'ನನ್ನ ಪ್ರೊಫೈಲ್', 'emergency.html': 'ತುರ್ತು SOS'
      },
      phrases: {
        'Accident Map': 'ಅಪಘಾತ ನಕ್ಷೆ', 'Filters': 'ಶೋಧಕಗಳು', 'Apply': 'ಅನ್ವಯಿಸಿ', 'Reset': 'ಮರುಹೊಂದಿಸಿ',
        'Share this view': 'ಈ ನೋಟ ಹಂಚಿಕೊಳ್ಳಿ', 'Road risk outlook': 'ರಸ್ತೆ ಅಪಾಯ ಸೂಚನೆ',
        'Report Accident': 'ಅಪಘಾತ ವರದಿ ಮಾಡಿ', 'View Live Map': 'ಲೈವ್ ನಕ್ಷೆ ನೋಡಿ',
        'Emergency SOS': 'ತುರ್ತು SOS', 'Emergency assistance': 'ತುರ್ತು ಸಹಾಯ',
        'Call 112': '112 ಕರೆ ಮಾಡಿ', 'Call 108 Ambulance': '108 ಆಂಬುಲೆನ್ಸ್ ಕರೆ ಮಾಡಿ',
        'Civic Action Tracker': 'ನಾಗರಿಕ ಕ್ರಮ ಟ್ರ್ಯಾಕರ್', 'Flag a safety issue': 'ಸುರಕ್ಷತಾ ಸಮಸ್ಯೆ ದಾಖಲಿಸಿ',
        'Trends & Analytics': 'ಪ್ರವೃತ್ತಿಗಳು ಮತ್ತು ವಿಶ್ಲೇಷಣೆ', 'My Profile': 'ನನ್ನ ಪ್ರೊಫೈಲ್'
      }
    }
  };

  var GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

  function stored() {
    try { var v = localStorage.getItem(STORE_KEY); return languages[v] ? v : 'en'; } catch (e) { return 'en'; }
  }
  function remember(lang) {
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* storage blocked */ }
  }

  function translate(lang) {
    var t = languages[lang] || languages.en;
    document.documentElement.lang = lang;

    // Sidebar: swap only the label text; the icon and badge stay intact.
    document.querySelectorAll('.app-sidebar-link[href]').forEach(function (link) {
      var label = link.querySelector('.app-sidebar-label');
      if (!label) return;
      if (!label.dataset.batI18n) label.dataset.batI18n = label.textContent;
      var text = t.nav[link.getAttribute('href')] || label.dataset.batI18n;
      label.textContent = text;
      link.setAttribute('aria-label', text);
    });

    // Headings, buttons and opted-in elements whose only content is text.
    document.querySelectorAll('[data-bat-i18n]:not(.app-sidebar-label), h1, h2, h3, button, .card-label, .heat-label').forEach(function (el) {
      if (el.closest('.app-sidebar') || el.children.length || !el.textContent.trim()) return;
      var original = el.dataset.batI18n || el.textContent.trim();
      if (t.phrases[original]) {
        el.dataset.batI18n = original;
        el.textContent = t.phrases[original];
      } else if (el.dataset.batI18n) {
        // Only restore text we translated; leave text other scripts manage alone.
        el.textContent = original;
      }
    });

    var sideLabel = document.getElementById('app-lang-label');
    if (sideLabel) sideLabel.textContent = t.label;
    var picker = document.getElementById('bat-lang-select');
    if (picker) picker.value = lang;
  }

  function setLanguage(lang) {
    remember(lang);
    translate(lang);
  }

  function mountSidebarItem(nav) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'app-lang';
    btn.className = 'app-sidebar-link app-sidebar-lang';
    btn.title = 'Change language';
    btn.setAttribute('aria-label', 'Change language');
    btn.innerHTML = GLOBE + '<span class="app-sidebar-label" id="app-lang-label"></span>';
    btn.addEventListener('click', function () {
      var next = ORDER[(ORDER.indexOf(stored()) + 1) % ORDER.length];
      setLanguage(next);
    });
    nav.appendChild(btn);
  }

  function mountFloatingPicker() {
    var select = document.createElement('select');
    select.id = 'bat-lang-select';
    select.setAttribute('aria-label', 'Choose language');
    select.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:900;padding:8px 10px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font:inherit;font-size:14px;box-shadow:0 4px 14px rgba(15,23,42,.08)';
    ORDER.forEach(function (key) {
      var option = document.createElement('option');
      option.value = key;
      option.textContent = languages[key].label;
      select.appendChild(option);
    });
    select.addEventListener('change', function () { setLanguage(select.value); });
    document.body.appendChild(select);
  }

  function mount() {
    var nav = document.querySelector('.app-sidebar-nav');
    if (nav) mountSidebarItem(nav); else mountFloatingPicker();
    translate(stored());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();

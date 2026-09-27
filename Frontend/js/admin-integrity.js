/**
 * Admin: AI integrity checks (semantic duplicates, spam, fake-image forensics).
 * Hooks used by admin-app.js:
 *   BATIntegrity.init(authenticatedFetch, API)
 *   BATIntegrity.loadBadges(tbody)          — verdict pills on pending user reports
 *   BATIntegrity.renderPanel(container, id)  — full report inside the Review modal
 * Plus a stand-alone "Image check" lab (toolbar button) for testing any photo.
 * All model/user text is inserted with textContent.
 */
(function () {
  'use strict';
  const el = (window.BATAI && window.BATAI.el) || function (tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v); });
    [].concat(kids).filter(Boolean).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  };

  let doFetch = null;
  let API = '';

  const VERDICT = {
    looks_ok: { label: 'AI: looks OK', cls: 'ok' },
    needs_review: { label: 'AI: review', cls: 'review' },
    likely_duplicate: { label: 'AI: duplicate?', cls: 'bad' },
    likely_fake_or_spam: { label: 'AI: spam / fake?', cls: 'bad' },
  };
  const IMG_VERDICT = { likely_authentic: ['Likely authentic', 'ok'], needs_review: ['Needs review', 'review'], likely_fake: ['Likely fake / reused', 'bad'] };

  function pill(verdict, score) {
    const v = VERDICT[verdict] || { label: 'AI: n/a', cls: 'pending' };
    return el('span', { class: `integrity-pill ${v.cls}`, text: score != null ? `${v.label} · ${Math.round(score * 100)}%` : v.label });
  }

  async function getJson(url, opts) {
    const r = await doFetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function loadBadges(tbody) {
    if (!doFetch || !tbody) return;
    const spans = [...tbody.querySelectorAll('[data-integrity-id]')];
    if (!spans.length) return;
    const ids = spans.map(s => s.dataset.integrityId);
    let summaries = {};
    try { summaries = await getJson(`${API}/api/admin/integrity?ids=${encodeURIComponent(ids.join(','))}`); } catch (_) { return; }
    const missing = [];
    spans.forEach(s => {
      const sum = summaries[s.dataset.integrityId];
      if (sum) s.replaceWith(pill(sum.verdict, sum.score));
      else { s.textContent = 'AI check…'; missing.push(s); }
    });
    // Older reports (submitted before this feature) get checked now, a few at a time.
    for (const s of missing.slice(0, 10)) {
      try {
        const res = await getJson(`${API}/api/admin/integrity/${encodeURIComponent(s.dataset.integrityId)}`);
        if (s.isConnected) s.replaceWith(pill(res.overall.verdict, res.overall.score));
      } catch (_) { if (s.isConnected) s.textContent = 'AI: n/a'; }
    }
  }

  function list(items) {
    return items.length ? el('ul', {}, items.map(t => el('li', { text: t }))) : el('p', { style: 'font-size:13px;color:#64748b;margin:4px 0 0', text: 'No signals.' });
  }

  function imageSection(img) {
    if (!img) return el('div', { class: 'integrity-section-title', text: 'Photo: none attached' });
    if (img.error) return el('div', {}, [el('div', { class: 'integrity-section-title', text: 'Photo' }), list([img.signals?.[0]?.message || img.error])]);
    const [label, cls] = IMG_VERDICT[img.verdict] || ['Unknown', 'pending'];
    const parts = [
      el('div', { class: 'integrity-section-title' }, ['Photo forensics ', el('span', { class: `integrity-pill ${cls}`, text: `${label} · ${Math.round(img.fakeScore * 100)}%` })]),
      list(img.signals.map(s => s.message)),
    ];
    const facts = [];
    if (img.image) facts.push(`${String(img.image.format).toUpperCase()} ${img.image.width}×${img.image.height}, ${Math.round(img.image.bytes / 1024)} KB, hash ${img.image.hash}`);
    if (img.exif) facts.push(`Camera: ${[img.exif.make, img.exif.model].filter(Boolean).join(' ') || 'unknown'}; taken ${img.exif.taken ? new Date(img.exif.taken).toLocaleString() : 'unknown'}; GPS ${img.exif.gps ? `${img.exif.gps.lat.toFixed(4)}, ${img.exif.gps.lng.toFixed(4)}` : 'none'}${img.exif.software ? `; software ${img.exif.software}` : ''}`);
    else facts.push('No EXIF metadata.');
    if (img.detector && img.detector.aiProbability != null) facts.push(`AI-image detector (${img.detector.model.split('/').pop()}): ${Math.round(img.detector.aiProbability * 100)}% AI${img.detector.reliable === false ? ' — low-resolution input, treat with caution' : ''}`);
    if (img.vision && !img.vision.error && !img.vision.skipped) facts.push(`Vision model (${String(img.vision.model).split('/').pop()}): ${img.vision.notes || ''}`);
    if (img.vision?.skipped) facts.push(`Vision check skipped: ${img.vision.skipped}`);
    parts.push(el('div', { class: 'integrity-section-title', text: 'Details' }), list(facts));
    if (img.ela && img.ela.image) {
      parts.push(el('div', { class: 'integrity-section-title', text: `Error level analysis${img.ela.localizedAnomaly ? ' — localised anomaly' : ''}` }));
      parts.push(el('img', { class: 'integrity-ela', src: img.ela.image, alt: 'Error level analysis map: bright regions re-compress differently' }));
      parts.push(el('p', { class: 'integrity-caveat', text: 'Bright patches that stand out from their surroundings can indicate edited regions. Edges and text are naturally brighter.' }));
    }
    return el('div', {}, parts);
  }

  function textSection(t) {
    if (!t) return null;
    const dups = (t.duplicates || []).map(d => `#${d.id} ${d.title ? `“${String(d.title).slice(0, 60)}”` : ''} — ${d.distanceM} m away, ${d.date || 'undated'}, text similarity ${d.textSimilarity}, match ${Math.round(d.score * 100)}% (${d.status})`);
    return el('div', {}, [
      el('div', { class: 'integrity-section-title', text: `Text · spam ${Math.round(t.spamScore * 100)}% (${t.spamVerdict.replace('_', ' ')}) · embeddings: ${t.method}` }),
      list(t.signals.map(s => s.message)),
      el('div', { class: 'integrity-section-title', text: `Possible duplicates (${t.duplicateVerdict.replace('_', ' ')})` }),
      list(dups),
    ]);
  }

  function renderResult(container, res, id) {
    const actions = el('div', { class: 'integrity-actions' }, [
      el('button', { class: 'btn-cancel', type: 'button', text: 'Re-run check', onclick: () => run(container, id, false) }),
      el('button', { class: 'btn-cancel', type: 'button', text: 'Deep check with vision AI (1 free call)', onclick: () => run(container, id, true) }),
    ]);
    container.replaceChildren(el('div', { class: 'integrity-panel' }, [
      el('h4', {}, [el('span', { text: 'AI integrity check' }), pill(res.overall.verdict, res.overall.score)]),
      res.overall.reasons.length ? list(res.overall.reasons) : null,
      textSection(res.text),
      imageSection(res.image),
      el('p', { class: 'integrity-caveat', text: `Checked ${new Date(res.checkedAt).toLocaleString()}. Automated signals support your judgement; they are not proof.` }),
      actions,
    ]));
  }

  async function run(container, id, deep) {
    container.replaceChildren(el('div', { class: 'integrity-panel', text: deep ? 'Running deep check (vision model)…' : 'Running AI integrity check…' }));
    try {
      const res = await getJson(`${API}/api/admin/integrity/${encodeURIComponent(id)}/check${deep ? '?deep=1' : ''}`, { method: 'POST', body: '{}' });
      renderResult(container, res, id);
    } catch (e) { container.replaceChildren(el('div', { class: 'integrity-panel', text: `Integrity check failed: ${e.message}` })); }
  }

  async function renderPanel(container, id) {
    if (!container || !doFetch) return;
    container.replaceChildren(el('div', { class: 'integrity-panel', text: 'Loading AI integrity check…' }));
    try { renderResult(container, await getJson(`${API}/api/admin/integrity/${encodeURIComponent(id)}`), id); }
    catch (e) { container.replaceChildren(el('div', { class: 'integrity-panel', text: `Integrity check unavailable: ${e.message}` })); }
  }

  // ── Image check lab ───────────────────────────────────────────────────────
  function openLab() {
    const modal = document.getElementById('image-lab-modal');
    if (!modal) return;
    modal.hidden = false;
  }

  function wireLab() {
    const modal = document.getElementById('image-lab-modal');
    if (!modal) return;
    const close = () => { modal.hidden = true; };
    ['image-lab-close', 'image-lab-cancel'].forEach(i => document.getElementById(i)?.addEventListener('click', close));
    document.getElementById('image-lab-btn')?.addEventListener('click', openLab);
    document.getElementById('image-lab-run')?.addEventListener('click', async () => {
      const file = document.getElementById('image-lab-file').files[0];
      const out = document.getElementById('image-lab-result');
      if (!file) { out.replaceChildren(el('p', { text: 'Choose an image first.' })); return; }
      if (file.size > 10 * 1024 * 1024) { out.replaceChildren(el('p', { text: 'Image must be under 10 MB.' })); return; }
      const deep = document.getElementById('image-lab-deep').checked;
      const date = document.getElementById('image-lab-date').value;
      out.replaceChildren(el('p', { text: 'Analysing (first run downloads the local models, which can take a minute)…' }));
      try {
        const qs = new URLSearchParams();
        if (deep) qs.set('deep', '1');
        if (date) qs.set('date', date);
        const res = await getJson(`${API}/api/admin/integrity/image-test?${qs}`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
        out.replaceChildren(el('div', { class: 'integrity-panel' }, [imageSection(res), el('p', { class: 'integrity-caveat', text: res.caveat })]));
      } catch (e) { out.replaceChildren(el('p', { text: `Failed: ${e.message}` })); }
    });
  }

  function init(fetchFn, apiBase) {
    doFetch = fetchFn;
    API = apiBase;
    wireLab();
  }

  window.BATIntegrity = { init, loadBadges, renderPanel, openLab };
})();

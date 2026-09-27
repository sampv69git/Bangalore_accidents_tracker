import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { heuristicSpamSignals, gibberishScore, buildLetterModel, rareBigramFraction, noisyOr, checkReportText, dHash, hamming, analyzeImage, errorLevelAnalysis, fetchProofImage, overallVerdict } from '../ai/integrity.mjs';
import { makeRecord } from './fixtures/ai-fixtures.js';

beforeAll(() => {
  // Keep tests offline and fast: no model downloads, no LLM calls.
  process.env.AI_DISABLE_LOCAL_MODELS = 'true';
  process.env.AI_DISABLE_LLM = 'true';
});

describe('spam heuristics', () => {
  it('flags links, contact details and promotional language', () => {
    const codes = heuristicSpamSignals('BUY CHEAP watches, huge discount at www.deals.xyz or WhatsApp 9876543210').map(s => s.code);
    expect(codes).toEqual(expect.arrayContaining(['LINK', 'CONTACT_INFO', 'PROMOTIONAL']));
  });

  it('detects keyboard mash but not real descriptions or Kannada text', () => {
    expect(gibberishScore('wdfgvhbjnkmertvbhnjmk')).toBeGreaterThan(0.35);
    expect(gibberishScore('asdfghjkl qwertyuiop zxcvbnm')).toBeGreaterThan(0.35);
    expect(gibberishScore('BMTC bus rammed a two wheeler near Nagarbhavi circle, rider hospitalised')).toBeLessThan(0.35);
    expect(gibberishScore('ಬೈಕ್ ಸವಾರನಿಗೆ ಬಸ್ ಡಿಕ್ಕಿ')).toBe(0);
  });

  it('letter-pair model trained on real titles catches row-hopping mash but not Bengaluru place names', async () => {
    const fs = await import('fs');
    const titles = JSON.parse(fs.readFileSync(new URL('../../Frontend/accident_data.json', import.meta.url), 'utf8')).map(r => `${r.title} ${r.location}`);
    const model = buildLetterModel(titles);
    expect(rareBigramFraction(model, 'wertcvybunimxerctvybunimo')).toBeGreaterThanOrEqual(0.12);
    expect(rareBigramFraction(model, 'Accident at Kadubeesanahalli near the signal')).toBeLessThan(0.12);
    expect(rareBigramFraction(model, 'Scooter skidded near Byatarayanapura, rider hurt')).toBeLessThan(0.12);
    expect(heuristicSpamSignals('wertcvybunimxerctvybunimo', { letterModel: model }).map(s => s.code)).toContain('GIBBERISH');
  });

  it('combines independent signals with noisy-OR', () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(0.75);
  });
});

describe('checkReportText (hashed TF-IDF fallback)', () => {
  const existing = [
    makeRecord({ id: 'a', title: 'Bike rider killed after BMTC bus hits him at Silk Board junction', location: 'Silk Board', lat: 12.9170, lng: 77.6230, date: '2026-09-20' }),
    makeRecord({ id: 'b', title: 'Car overturns on Hebbal flyover', location: 'Hebbal', lat: 13.0358, lng: 77.5970, date: '2026-09-20' }),
  ];

  it('finds a nearby paraphrased duplicate', async () => {
    const report = makeRecord({ id: 'new', status: 'pending', lat: 12.9172, lng: 77.6231, date: '2026-09-20', description: 'BMTC bus hit a bike rider at Silk Board junction, rider killed', location: 'Silk Board' });
    const r = await checkReportText(report, existing, { forceFallback: true });
    expect(r.method).toBe('hashed-tfidf');
    expect(r.duplicates[0].id).toBe('a');
    expect(r.duplicateVerdict).toBe('likely_duplicate');
    expect(r.spamVerdict).toBe('ok');
  });

  it('marks gibberish as likely spam', async () => {
    const report = makeRecord({ id: 'junk', status: 'pending', lat: 12.99, lng: 77.70, date: '2026-09-21', description: 'sfdghmsdfgsdfgsdfgsdfg', location: 'x' });
    const r = await checkReportText(report, existing, { forceFallback: true });
    expect(r.signals.map(s => s.code)).toContain('GIBBERISH');
    expect(r.spamVerdict).toBe('likely_spam');
  });
});

describe('image forensics', () => {
  let photo;
  beforeAll(async () => {
    // A photo-like synthetic scene (sky/road gradients + shapes + mild noise):
    // smooth structure like a real photo, so hashes behave realistically under resizing.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#87b5e5"/><stop offset="1" stop-color="#dfe9f3"/></linearGradient></defs>
      <rect width="640" height="260" fill="url(#sky)"/><rect y="260" width="640" height="220" fill="#555a60"/>
      <rect x="120" y="200" width="220" height="110" rx="18" fill="#b3261e"/><circle cx="170" cy="315" r="28" fill="#111"/><circle cx="295" cy="315" r="28" fill="#111"/>
      <rect x="420" y="150" width="60" height="160" fill="#2e7d32"/><polygon points="0,480 280,300 360,300 640,480" fill="#6b7078"/></svg>`;
    const base = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    const noisy = Buffer.from(base.data);
    for (let i = 0; i < noisy.length; i++) noisy[i] = Math.max(0, Math.min(255, noisy[i] + ((i * 2654435761) % 13) - 6));
    photo = await sharp(noisy, { raw: base.info }).jpeg({ quality: 85 }).toBuffer();
  });

  it('perceptual hash survives resizing and re-compression', async () => {
    const copy = await sharp(photo).resize(320).jpeg({ quality: 60 }).toBuffer();
    expect(hamming(await dHash(photo), await dHash(copy))).toBeLessThanOrEqual(6);
  });

  it('flags a photo reused from an earlier report', async () => {
    const r = await analyzeImage(await sharp(photo).resize(500).jpeg().toBuffer(), { knownHashes: [{ id: 'old-1', hash: await dHash(photo) }], withElaImage: false });
    const reuse = r.signals.find(s => s.code === 'REUSED_IMAGE');
    expect(reuse.ids).toEqual(['old-1']);
  });

  it('flags editing software and a capture date far from the reported date', async () => {
    const edited = await sharp(photo).withExif({ IFD0: { Software: 'Adobe Photoshop 25.0', Make: 'Canon', Model: 'EOS' } }).jpeg().toBuffer();
    const r = await analyzeImage(edited, { withElaImage: false });
    expect(r.signals.map(s => s.code)).toContain('EDITED');
    expect(r.exif.make).toBe('Canon');

    const old = await sharp(photo).withExif({ IFD0: { Make: 'Samsung', Model: 'S21' }, IFD2: { DateTimeOriginal: '2019:01:05 10:00:00' } }).jpeg().toBuffer();
    const r2 = await analyzeImage(old, { reported: { date: '2026-09-20' }, withElaImage: false });
    expect(r2.signals.map(s => s.code)).toContain('DATE_MISMATCH');
  });

  it('flags AI-generator metadata as likely fake', async () => {
    const ai = await sharp(photo).withExif({ IFD0: { Software: 'Stable Diffusion XL' } }).jpeg().toBuffer();
    const r = await analyzeImage(ai, { withElaImage: false });
    expect(r.signals.map(s => s.code)).toContain('AI_METADATA');
    expect(r.verdict).toBe('likely_fake');
  });

  it('produces an ELA map for JPEGs and skips PNGs', async () => {
    const ela = await errorLevelAnalysis(photo);
    expect(ela.applicable).toBe(true);
    expect(ela.image).toMatch(/^data:image\/png;base64,/);
    const png = await sharp(photo).png().toBuffer();
    expect((await errorLevelAnalysis(png)).applicable).toBe(false);
  });
});

describe('fetchProofImage (SSRF guard)', () => {
  it('only downloads https images from allow-listed hosts', async () => {
    await expect(fetchProofImage('http://xcjzfifybnzocyjlktpo.supabase.co/a.jpg')).rejects.toThrow(/https/);
    await expect(fetchProofImage('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/allow-listed/);
    await expect(fetchProofImage('https://evil.example.com/a.jpg')).rejects.toThrow(/allow-listed/);
  });
});

describe('overallVerdict', () => {
  it('escalates duplicates and spam/fakes', () => {
    expect(overallVerdict({ duplicateVerdict: 'likely_duplicate', spamVerdict: 'ok', duplicates: [{ score: 0.9 }] }, null).verdict).toBe('likely_duplicate');
    expect(overallVerdict({ duplicateVerdict: 'none', spamVerdict: 'likely_spam', spamScore: 0.8, duplicates: [] }, null).verdict).toBe('likely_fake_or_spam');
    expect(overallVerdict({ duplicateVerdict: 'none', spamVerdict: 'ok', spamScore: 0, duplicates: [] }, { verdict: 'likely_authentic', fakeScore: 0.1 }).verdict).toBe('looks_ok');
  });
});

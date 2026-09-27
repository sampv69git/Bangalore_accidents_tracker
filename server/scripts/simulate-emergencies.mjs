/**
 * Generate DRILL emergency alerts so the response-time dashboard has data to
 * show before real SOS alerts exist. Alerts are placed at real accident
 * hotspots, go through the real dispatch service (ranking, escalation,
 * accept, lifecycle) on a simulated clock, and are flagged is_drill = true —
 * excluded from metrics unless "Include drill alerts" is ticked.
 *
 *   node scripts/simulate-emergencies.mjs                 60 drills over the last 30 days
 *   node scripts/simulate-emergencies.mjs --count 100 --days 60
 *   node scripts/simulate-emergencies.mjs --clear         delete all drill alerts
 *
 * Uses straight-line drive-time estimates (no OSRM calls) to stay polite to
 * the free routing server.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { createPgStore } from '../emergency/store-pg.mjs';
import { createEmergencyService } from '../emergency/service.mjs';
import { createRouter } from '../emergency/routing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const COUNT = Math.max(1, parseInt(arg('--count', '60'), 10));
const DAYS = Math.max(1, parseInt(arg('--days', '30'), 10));
const CLEAR = process.argv.includes('--clear');

const databaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) { console.error('Set DATABASE_URL first.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const store = createPgStore({ pool });

// Deterministic pseudo-random so repeated runs look similar.
let seed = 20260927;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);
/** Log-normal-ish delay (minutes) with the given median. */
const delay = (median, spread = 0.5) => median * Math.exp((rand() * 2 - 1) * spread);

function hotspots() {
  const file = path.join(__dirname, '..', '..', 'Frontend', 'accident_data.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter(r => r.lat && r.lng && (r.status || 'active') === 'active');
  // Weight towards serious/fatal locations.
  return rows.flatMap(r => Array(r.severity === 'fatal' ? 3 : r.severity === 'serious' ? 2 : 1).fill(r));
}

// Hour-of-day distribution skewed to Bengaluru peak traffic (IST).
const HOURS = [0, 1, 2, 5, 6, 7, 8, 8, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 18, 19, 19, 20, 21, 22, 23];
const TRIAGE = [
  { injured: '1', conscious: 'yes', vehicles: ['two_wheeler'] },
  { injured: '1', bleeding: 'yes', vehicles: ['two_wheeler', 'car'] },
  { injured: '2', conscious: 'no', vehicles: ['car', 'bus_truck'] },
  { injured: '1', vehicles: ['pedestrian', 'car'] },
  { injured: '3+', trapped: 'yes', vehicles: ['car', 'bus_truck'] },
  { injured: '0', vehicles: ['car', 'auto'] },
  { injured: 'unknown' },
];

async function simulateOne(svc, clk, spot) {
  const dayOffset = Math.floor(rand() * DAYS);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - dayOffset);
  // IST = UTC+5:30
  start.setUTCHours(pick(HOURS) - 5, Math.floor(rand() * 60) - 30, 0, 0);
  if (start > new Date()) start.setUTCDate(start.getUTCDate() - 1);
  clk.set(start);

  const lat = Number(spot.lat) + between(-0.002, 0.002), lng = Number(spot.lng) + between(-0.002, 0.002);
  const { alert } = await svc.createAlert({ lat, lng, triage: pick(TRIAGE), address: spot.location || spot.area || null }, { isDrill: true });
  const fate = rand();

  if (fate < 0.07) { // bystander cancels
    clk.advance(delay(3) * 60);
    await svc.cancelAlert(alert.id, { kind: 'reporter' }, pick(['Patient taken to hospital by another vehicle', '108 ambulance arrived']));
    return 'cancelled';
  }

  // Rounds pass without an answer (escalation); a few alerts are never accepted.
  const rounds = fate < 0.12 ? 4 : fate < 0.25 ? 2 : fate < 0.32 ? 3 : 1;
  for (let r = 1; r < rounds; r++) {
    clk.advance(svc.config.roundTimeoutSec + 1);
    await svc.sweep();
  }
  if (rounds === 4) return 'unanswered';

  clk.advance(delay(1.4, 0.7) * 60);
  const targets = await store.getTargets(alert.id);
  const round = targets.filter(t => t.round === Math.max(...targets.map(x => x.round)));
  const t = pick(round.length ? round : targets);
  const hospital = await store.getHospital(t.hospital_id);
  await svc.acceptAlert(alert.id, { userId: 'drill', hospital });
  const actor = { kind: 'hospital', hospital };
  const eta = t.eta_min || 10;

  clk.advance(delay(2.5, 0.4) * 60);
  await svc.setStatus(alert.id, 'dispatched', actor);
  clk.advance(eta * between(0.9, 1.5) * 60);
  await svc.setStatus(alert.id, 'on_scene', actor);
  clk.advance(delay(9, 0.4) * 60);
  if (rand() < 0.1) { await svc.setStatus(alert.id, 'closed', actor, { outcome: 'treated_on_scene' }); return 'treated'; }
  await svc.setStatus(alert.id, 'transporting', actor);
  clk.advance(eta * between(0.8, 1.3) * 60 + delay(4) * 60);
  await svc.setStatus(alert.id, 'closed', actor, { outcome: 'handed_over' });
  return 'transported';
}

async function main() {
  await store.ready();
  if (CLEAR) {
    console.log(`Deleted ${await store.deleteDrills()} drill alerts.`);
    return;
  }
  let t = Date.now();
  const clk = { now: () => new Date(t), set: (d) => { t = d.getTime(); }, advance: (sec) => { t += sec * 1000; } };
  const svc = createEmergencyService({
    store, router: createRouter({ disabled: true, now: clk.now }), bus: null, now: clk.now,
    logger: { log() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
  });
  const spots = hotspots();
  const tally = {};
  for (let i = 0; i < COUNT; i++) {
    const outcome = await simulateOne(svc, clk, pick(spots));
    tally[outcome] = (tally[outcome] || 0) + 1;
    process.stdout.write(`\r  ${i + 1}/${COUNT}`);
  }
  await svc.idle();
  console.log(`\nCreated ${COUNT} drill alerts over the last ${DAYS} days:`, tally);
  console.log('Tick "Include drill alerts" on coverage.html to see them. Remove with --clear.');
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());

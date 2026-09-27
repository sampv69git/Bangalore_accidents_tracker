/**
 * Emergency response metrics ("golden hour" dashboard).
 *
 * Pure function over alert rows so it is easy to test. Times are minutes from
 * the SOS being raised. The golden hour is measured as SOS → patient handed
 * over at hospital (closed after transporting) ≤ 60 min.
 */
import { minutesBetween } from './util.mjs';

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

export function quantile(values, q) {
  const xs = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}
const median = (xs) => r1(quantile(xs, 0.5));
const p90 = (xs) => r1(quantile(xs, 0.9));
const share = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

const IST_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' });
const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

function timings(a) {
  return {
    toAccept: minutesBetween(a.created_at, a.accepted_at),
    toScene: minutesBetween(a.created_at, a.on_scene_at),
    acceptToScene: a.accepted_at ? minutesBetween(a.accepted_at, a.on_scene_at) : null,
    toHospital: a.transporting_at ? minutesBetween(a.created_at, a.closed_at) : null,
  };
}

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function block(rows) {
  const t = rows.map(timings);
  return {
    total: rows.length,
    accepted: rows.filter(r => r.accepted_at).length,
    reached: rows.filter(r => r.on_scene_at).length,
    unanswered: rows.filter(r => r.escalation_exhausted_at && !r.accepted_at).length,
    median_accept_min: median(t.map(x => x.toAccept)),
    median_to_scene_min: median(t.map(x => x.toScene)),
  };
}

export function computeResponseMetrics(rows, { now = new Date(), days = 30 } = {}) {
  const t = rows.map(timings);
  const reached = t.filter(x => x.toScene != null);
  const transported = t.filter(x => x.toHospital != null);
  const accepted = rows.filter(r => r.accepted_at);

  const summary = {
    total: rows.length,
    accepted: accepted.length,
    accept_rate_pct: share(accepted.length, rows.filter(r => r.status !== 'cancelled' || r.accepted_at).length),
    cancelled: rows.filter(r => r.status === 'cancelled').length,
    unanswered: rows.filter(r => r.escalation_exhausted_at && !r.accepted_at).length,
    merged_reports: rows.reduce((s, r) => s + Math.max(0, (r.report_count || 1) - 1), 0),
    median_accept_min: median(t.map(x => x.toAccept)),
    p90_accept_min: p90(t.map(x => x.toAccept)),
    median_to_scene_min: median(reached.map(x => x.toScene)),
    p90_to_scene_min: p90(reached.map(x => x.toScene)),
    median_accept_to_scene_min: median(t.map(x => x.acceptToScene)),
    reached: reached.length,
    within_10_min_pct: share(reached.filter(x => x.toScene <= 10).length, reached.length),
    within_20_min_pct: share(reached.filter(x => x.toScene <= 20).length, reached.length),
    transported: transported.length,
    median_to_hospital_min: median(transported.map(x => x.toHospital)),
    golden_hour_pct: share(transported.filter(x => x.toHospital <= 60).length, transported.length),
  };

  const byZone = [...group(rows, r => r.zone || 'Other')].map(([zone, rs]) => ({ zone, ...block(rs) }))
    .sort((a, b) => b.total - a.total);

  const hourGroups = group(rows, r => Number(IST_HOUR.format(new Date(r.created_at))));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...block(hourGroups.get(h) || []) }));

  const byPriority = ['critical', 'urgent', 'standard'].map(p => ({ priority: p, ...block(rows.filter(r => r.priority === p)) }));

  const acceptedRound = group(accepted, r => r.escalation_round || 1);
  const escalation = [...acceptedRound].map(([round, rs]) => ({ round: Number(round), accepted: rs.length })).sort((a, b) => a.round - b.round);

  const hospitals = [...group(accepted, r => r.accepted_hospital_id)].map(([id, rs]) => ({
    id, name: rs[0].accepted_hospital_name, accepted: rs.length,
    median_accept_min: median(rs.map(r => timings(r).toAccept)),
    median_accept_to_scene_min: median(rs.map(r => timings(r).acceptToScene)),
  })).sort((a, b) => b.accepted - a.accepted).slice(0, 10);

  const byDate = group(rows, r => IST_DATE.format(new Date(r.created_at)));
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = IST_DATE.format(new Date(now.getTime() - i * 86400000));
    const rs = byDate.get(d) || [];
    daily.push({ date: d, total: rs.length, median_to_scene_min: median(rs.map(r => timings(r).toScene)) });
  }

  return { summary, byZone, byHour, byPriority, escalation, hospitals, daily };
}

/**
 * "Ask BAT" — natural-language analytics agent.
 *
 * The LLM never writes SQL or touches the database. It can only call the
 * allow-listed tools below; every argument is validated and clamped before a
 * tool runs, and tools run on the server's in-memory copy of active records.
 *
 * Loop (max 3 rounds):  plan → call tools → observe results → answer.
 * Charts come from real tool output only (the model just picks which one).
 * Every number in the final answer is checked against the tool results; if the
 * model states an unsupported figure, a deterministic answer is used instead.
 *
 * Without an API key / when the free daily budget is used up, a rule-based
 * planner picks the tools, so the feature still works offline.
 */
import { chatJSON, llmAvailable, unsupportedNumbers, severityClaimErrors } from './llm.mjs';
import { topRiskCells } from './risk-model.mjs';

const ZONES = ['North', 'South', 'East', 'West', 'Central', 'Highway / ORR', 'Other'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEV = ['fatal', 'serious', 'minor'];

// ── Argument validation ─────────────────────────────────────────────────────

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : typeof v === 'string' && /^\d{4}$/.test(v) ? v : null);
const cleanStr = (v, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function validateFilters(a = {}) {
  const f = {};
  f.place = cleanStr(a.place ?? a.area);
  const z = ZONES.find(zz => zz.toLowerCase() === String(a.zone || '').toLowerCase());
  if (z) f.zone = z;
  if (SEV.includes(a.severity)) f.severity = a.severity;
  const from = isoDate(a.from), to = isoDate(a.to);
  if (from) f.from = from.length === 4 ? `${from}-01-01` : from;
  if (to) f.to = to.length === 4 ? `${to}-12-31` : to;
  if (a.hour_from != null && a.hour_from !== '') f.hour_from = clampInt(a.hour_from, 0, 23, null);
  if (a.hour_to != null && a.hour_to !== '') f.hour_to = clampInt(a.hour_to, 0, 23, null);
  if (f.hour_from == null) delete f.hour_from;
  if (f.hour_to == null) delete f.hour_to;
  return f;
}

// ── Place resolution (fuzzy, so "Kormangala" finds "Koramangala") ───────────

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function placeMatcher(place) {
  const q = norm(place);
  if (!q) return () => true;
  const qTokens = q.split(' ').filter(t => t.length >= 4);
  return (r) => {
    const hay = norm(`${r.area} ${r.location} ${r.title}`);
    if (hay.includes(q)) return true;
    if (!qTokens.length) return false;
    const words = hay.split(' ');
    return qTokens.every(t => words.some(w => w.length >= 4 && (w === t || (t.length >= 6 && lev(w, t) <= 2))));
  };
}

function hourMatch(h, from, to) {
  if (h == null) return false;
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}

/**
 * Like applyFilters, but if a time-of-day filter removes everything only because
 * records lack a time, re-run without it and say so (honest graceful degradation).
 */
export function applyFiltersSoft(records, f) {
  const res = applyFilters(records, f);
  if (res.rows.length === 0 && res.excludedNoTime > 0) {
    const { hour_from, hour_to, ...rest } = f;
    const relaxed = applyFilters(records, rest);
    return { rows: relaxed.rows, excludedNoTime: 0, timeFilterDropped: { hour_from, hour_to, recordsWithoutTime: res.excludedNoTime } };
  }
  return res;
}

export function applyFilters(records, f) {
  const matchPlace = placeMatcher(f.place);
  let excludedNoTime = 0;
  const hourFilter = f.hour_from != null || f.hour_to != null;
  const out = records.filter(r => {
    if (f.place && !matchPlace(r)) return false;
    if (f.zone && r.zone !== f.zone) return false;
    if (f.severity && r.severity !== f.severity) return false;
    if (f.from && (!r.date || r.date < f.from)) return false;
    if (f.to && (!r.date || r.date > f.to)) return false;
    if (hourFilter) {
      if (r.hour == null) { excludedNoTime++; return false; }
      if (!hourMatch(r.hour, f.hour_from ?? 0, f.hour_to ?? 23)) return false;
    }
    return true;
  });
  return { rows: out, excludedNoTime };
}

const sevCounts = (rows) => rows.reduce((a, r) => { a[r.severity]++; return a; }, { fatal: 0, serious: 0, minor: 0 });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const displayName = (r, by) => {
  if (by === 'zone') return r.zone || 'Unknown';
  const v = by === 'location' ? (r.location || r.area) : (r.area || r.location);
  return (v || 'Unknown').trim().slice(0, 50);
};

function timeNote(excludedNoTime, dropped) {
  if (dropped) return `none of the ${dropped.recordsWithoutTime} matching records include a time of day, so the ${dropped.hour_from ?? 0}:00–${dropped.hour_to ?? 23}:59 filter could not be applied and results cover all hours`;
  return excludedNoTime ? `${excludedNoTime} matching record(s) have no time of day and were excluded by the time filter` : null;
}

// ── Tools ───────────────────────────────────────────────────────────────────

const FILTER_DOC = 'Optional filters: place (area/road/landmark text), zone (North|South|East|West|Central|Highway / ORR|Other), severity (fatal|serious|minor), from/to (YYYY-MM-DD or YYYY), hour_from/hour_to (0-23, may wrap past midnight).';

export const TOOLS = {
  count_incidents: {
    description: `Count incidents with a severity breakdown. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters(a);
      const { rows, excludedNoTime, timeFilterDropped } = applyFiltersSoft(ctx.records, f);
      const s = sevCounts(rows);
      const dated = rows.filter(r => r.date).map(r => r.date).sort();
      return {
        filters: f, total: rows.length, bySeverity: s, fatalSharePct: pct(s.fatal, rows.length),
        dateRange: dated.length ? { first: dated[0], last: dated[dated.length - 1], datedRecords: dated.length } : null,
        note: timeNote(excludedNoTime, timeFilterDropped), timeFilterDropped: Boolean(timeFilterDropped),
        chart: rows.length ? { type: 'doughnut', title: 'Severity breakdown', labels: ['Fatal', 'Serious', 'Minor'], datasets: [{ label: 'Incidents', data: [s.fatal, s.serious, s.minor] }] } : null,
      };
    },
  },
  rank_places: {
    description: `Rank areas, zones or specific locations by number of incidents. Args: group_by (area|zone|location, default area), limit (1-15), plus filters. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters(a);
      const by = ['area', 'zone', 'location'].includes(a.group_by) ? a.group_by : 'area';
      const limit = clampInt(a.limit, 1, 15, 8);
      const { rows, excludedNoTime, timeFilterDropped } = applyFiltersSoft(ctx.records, f);
      const m = new Map();
      for (const r of rows) {
        const k = displayName(r, by);
        if (!m.has(k)) m.set(k, { name: k, total: 0, fatal: 0, serious: 0, minor: 0 });
        const e = m.get(k); e.total++; e[r.severity]++;
      }
      const ranked = [...m.values()].sort((x, y) => y.total - x.total || y.fatal - x.fatal).slice(0, limit);
      return {
        filters: f, groupBy: by, matched: rows.length, rows: ranked, note: timeNote(excludedNoTime, timeFilterDropped), timeFilterDropped: Boolean(timeFilterDropped),
        chart: ranked.length ? { type: 'bar', title: `Incidents by ${by}`, labels: ranked.map(x => x.name), datasets: [{ label: 'Fatal', data: ranked.map(x => x.fatal) }, { label: 'Serious', data: ranked.map(x => x.serious) }, { label: 'Minor', data: ranked.map(x => x.minor) }], stacked: true, horizontal: true } : null,
      };
    },
  },
  trend: {
    description: `Incidents over time (only records with a known date). Args: interval (month|year, default year), plus filters. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters(a);
      const interval = a.interval === 'month' ? 'month' : 'year';
      const { rows } = applyFilters(ctx.records, f);
      const dated = rows.filter(r => r.date);
      const m = new Map();
      for (const r of dated) {
        const k = interval === 'month' ? r.date.slice(0, 7) : r.date.slice(0, 4);
        if (!m.has(k)) m.set(k, { period: k, total: 0, fatal: 0 });
        const e = m.get(k); e.total++; if (r.severity === 'fatal') e.fatal++;
      }
      const series = [...m.values()].sort((x, y) => x.period.localeCompare(y.period));
      return {
        filters: f, interval, datedRecords: dated.length, undatedRecords: rows.length - dated.length, series,
        chart: series.length ? { type: 'line', title: `Incidents per ${interval}`, labels: series.map(s => s.period), datasets: [{ label: 'All', data: series.map(s => s.total) }, { label: 'Fatal', data: series.map(s => s.fatal) }] } : null,
      };
    },
  },
  time_pattern: {
    description: `When incidents happen: by hour of day and by day of week. Reports how many records actually have a time. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters({ ...a, hour_from: null, hour_to: null });
      const { rows } = applyFilters(ctx.records, f);
      const byHour = new Array(24).fill(0), byDay = new Array(7).fill(0);
      let withTime = 0, withDate = 0;
      for (const r of rows) {
        if (r.hour != null) { byHour[r.hour]++; withTime++; }
        if (r.dow != null) { byDay[r.dow]++; withDate++; }
      }
      const peakDay = withDate ? DAY_NAMES[byDay.indexOf(Math.max(...byDay))] : null;
      const peakHour = withTime ? byHour.indexOf(Math.max(...byHour)) : null;
      return {
        filters: f, matched: rows.length, recordsWithTime: withTime, recordsWithDate: withDate,
        byHour: withTime ? byHour : null, byDay, peakDay, peakHour,
        note: withTime < 10 ? `Only ${withTime} of ${rows.length} records include a time of day, so hour-of-day patterns cannot be judged reliably.` : null,
        chart: withTime >= 10
          ? { type: 'bar', title: 'Incidents by hour of day', labels: byHour.map((_, h) => `${h}:00`), datasets: [{ label: 'Incidents', data: byHour }] }
          : withDate ? { type: 'bar', title: 'Incidents by day of week', labels: DAY_NAMES, datasets: [{ label: 'Incidents', data: byDay }] } : null,
      };
    },
  },
  hotspots: {
    description: `Find the worst specific spots (junctions/road stretches) by clustering nearby incidents. Args: radius_m (150-1000, default 300), limit (1-10), plus filters. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters(a);
      const radius = clampInt(a.radius_m, 150, 1000, 300);
      const limit = clampInt(a.limit, 1, 10, 5);
      const { rows, excludedNoTime, timeFilterDropped } = applyFiltersSoft(ctx.records.filter(r => r.lat != null), f);
      const dLat = radius / 111000, dLng = radius / (111000 * Math.cos(12.97 * Math.PI / 180));
      const cells = new Map();
      for (const r of rows) {
        const k = `${Math.round(r.lat / dLat)}:${Math.round(r.lng / dLng)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(r);
      }
      const clusters = [...cells.values()].map(list => {
        const names = new Map();
        list.forEach(r => { const n = displayName(r, 'location'); names.set(n, (names.get(n) || 0) + 1); });
        const s = sevCounts(list);
        return {
          name: [...names.entries()].sort((x, y) => y[1] - x[1])[0][0],
          lat: Math.round((list.reduce((t, r) => t + r.lat, 0) / list.length) * 1e5) / 1e5,
          lng: Math.round((list.reduce((t, r) => t + r.lng, 0) / list.length) * 1e5) / 1e5,
          total: list.length, ...s,
          severityScore: s.fatal * 3 + s.serious * 2 + s.minor,
        };
      }).sort((x, y) => y.severityScore - x.severityScore || y.total - x.total).slice(0, limit);
      return {
        filters: f, radiusM: radius, matched: rows.length, clusters, note: timeNote(excludedNoTime, timeFilterDropped), timeFilterDropped: Boolean(timeFilterDropped),
        chart: clusters.length ? { type: 'bar', title: 'Worst spots (severity-weighted)', labels: clusters.map(c => c.name), datasets: [{ label: 'Fatal', data: clusters.map(c => c.fatal) }, { label: 'Serious', data: clusters.map(c => c.serious) }, { label: 'Minor', data: clusters.map(c => c.minor) }], stacked: true, horizontal: true } : null,
      };
    },
  },
  risk_forecast: {
    description: 'Predicted future risk from the trained hotspot model (Poisson regression on a 500 m grid). Args: place (optional text), zone (optional), limit (1-10).',
    run(ctx, a) {
      if (!ctx.model) return { error: 'Risk model not trained yet' };
      const f = validateFilters(a);
      const cells = topRiskCells(ctx.model, { limit: clampInt(a.limit, 1, 10, 5), area: f.place || null, zone: f.zone || null });
      return {
        filters: f,
        cells: cells.map(c => ({ name: c.name || c.area || 'Unnamed cell', level: c.level, relativeRisk: c.relativeRisk, pastIncidents: c.pastIncidents, pastFatal: c.pastFatal, lat: Math.round(c.lat * 1e4) / 1e4, lng: Math.round(c.lng * 1e4) / 1e4 })),
        modelQuality: ctx.model.metrics?.explanation,
        chart: cells.length ? { type: 'bar', title: 'Predicted risk (× average incident location)', labels: cells.map(c => c.name || 'cell'), datasets: [{ label: 'Relative risk', data: cells.map(c => c.relativeRisk) }], horizontal: true } : null,
      };
    },
  },
  compare_places: {
    description: 'Compare 2-5 places side by side. Args: places (array of place names), severity (optional), from/to (optional).',
    run(ctx, a) {
      const places = (Array.isArray(a.places) ? a.places : []).map(p => cleanStr(p)).filter(Boolean).slice(0, 5);
      if (places.length < 2) return { error: 'Need at least two places to compare' };
      const base = validateFilters({ ...a, place: null });
      const rowsOut = places.map(p => {
        const { rows } = applyFilters(ctx.records, { ...base, place: p });
        return { place: p, total: rows.length, ...sevCounts(rows) };
      });
      return {
        filters: { ...base, places }, rows: rowsOut,
        chart: { type: 'bar', title: 'Comparison', labels: rowsOut.map(r => r.place), datasets: [{ label: 'Fatal', data: rowsOut.map(r => r.fatal) }, { label: 'Serious', data: rowsOut.map(r => r.serious) }, { label: 'Minor', data: rowsOut.map(r => r.minor) }], stacked: true },
      };
    },
  },
  search_incidents: {
    description: `List individual incidents (newest first). Args: text (optional keywords like "bus" or "flyover"), limit (1-10), plus filters. ${FILTER_DOC}`,
    run(ctx, a) {
      const f = validateFilters(a);
      const text = cleanStr(a.text, 40);
      const limit = clampInt(a.limit, 1, 10, 5);
      let { rows } = applyFilters(ctx.records, f);
      if (text) { const t = text.toLowerCase(); rows = rows.filter(r => `${r.title} ${r.description} ${r.location}`.toLowerCase().includes(t)); }
      rows = rows.slice().sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
      return {
        filters: f, text, matched: rows.length,
        incidents: rows.slice(0, limit).map(r => ({ id: r.id, date: r.date, severity: r.severity, place: displayName(r, 'location'), title: r.title.slice(0, 120), link: r.link || null })),
        chart: null,
      };
    },
  },
};

export function runTool(ctx, name, args) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool "${name}". Allowed: ${Object.keys(TOOLS).join(', ')}` };
  try { return tool.run(ctx, args && typeof args === 'object' ? args : {}); }
  catch (e) { return { error: `Tool failed: ${e.message}` }; }
}

// ── Deterministic summaries (used offline and as grounding fallback) ────────

const placeLabel = (f) => [f.severity ? `${f.severity}` : '', 'incidents', f.place ? `matching "${f.place}"` : '', f.zone ? `in the ${f.zone} zone` : '',
  f.hour_from != null ? `between ${f.hour_from}:00 and ${f.hour_to ?? 23}:59` : '', f.from ? `from ${f.from}` : '', f.to ? `to ${f.to}` : ''].filter(Boolean).join(' ');

export function summarize(name, out) {
  if (!out || out.error) return out?.error || 'No result.';
  if (out.timeFilterDropped && out.filters) out = { ...out, filters: { ...out.filters, hour_from: undefined, hour_to: undefined } };
  const note = out.note ? ` Note: ${out.note}.` : '';
  switch (name) {
    case 'count_incidents':
      return `There are ${out.total} ${placeLabel(out.filters)}: ${out.bySeverity.fatal} fatal, ${out.bySeverity.serious} serious and ${out.bySeverity.minor} minor (${out.fatalSharePct}% fatal).${note}`;
    case 'rank_places':
      return out.rows.length
        ? `Top ${out.groupBy === 'zone' ? 'zones' : 'places'} for ${placeLabel(out.filters)}: ${out.rows.slice(0, 5).map(r => `${r.name} (${r.total}, ${r.fatal} fatal)`).join('; ')}.${note}`
        : `No ${placeLabel(out.filters)} found.${note}`;
    case 'trend': {
      if (!out.series.length) return `None of the matching records have a date, so no trend can be shown.`;
      const last = out.series[out.series.length - 1], peak = out.series.reduce((m, s) => (s.total > m.total ? s : m));
      return `Across ${out.datedRecords} dated records, the busiest ${out.interval} was ${peak.period} with ${peak.total} incident(s); the latest (${last.period}) had ${last.total}. ${out.undatedRecords} matching record(s) have no date.`;
    }
    case 'time_pattern':
      return out.recordsWithTime >= 10
        ? `The peak hour is ${out.peakHour}:00${out.peakDay ? ` and the busiest day is ${out.peakDay}` : ''} (${out.recordsWithTime} records have a time).`
        : `Only ${out.recordsWithTime} of ${out.matched} records include a time of day, so hour-based patterns are not reliable.${out.peakDay ? ` By day of week, ${out.peakDay} has the most incidents (${out.recordsWithDate} dated records).` : ''}`;
    case 'hotspots':
      return out.clusters.length
        ? `The worst spots for ${placeLabel(out.filters)} (within ${out.radiusM} m clusters): ${out.clusters.slice(0, 5).map(c => `${c.name} — ${c.total} incident(s), ${c.fatal} fatal`).join('; ')}.${note}`
        : `No ${placeLabel(out.filters)} found.${note}`;
    case 'risk_forecast':
      return out.cells?.length
        ? `Highest predicted risk: ${out.cells.map(c => `${c.name} (${c.relativeRisk}× the average incident location, ${c.pastIncidents} past incidents)`).join('; ')}.`
        : 'The model found no elevated-risk cells for that filter.';
    case 'compare_places':
      return out.rows.map(r => `${r.place}: ${r.total} (${r.fatal} fatal, ${r.serious} serious, ${r.minor} minor)`).join('; ') + '.';
    case 'search_incidents':
      return out.incidents.length
        ? `${out.matched} matching incident(s). Most recent: ${out.incidents.slice(0, 3).map(i => `${i.date || 'undated'} — ${i.title}`).join('; ')}.`
        : 'No matching incidents found.';
    default:
      return JSON.stringify(out).slice(0, 300);
  }
}

// ── Rule-based planner (offline mode) ───────────────────────────────────────

function knownPlaces(records) {
  const m = new Map();
  for (const r of records) {
    const a = (r.area || '').trim();
    if (a && a.length >= 3 && a.length <= 30 && !/^(the road|road|bengaluru|bangalore|flyover|unknown)$/i.test(a)) m.set(a.toLowerCase(), a);
  }
  return [...m.values()].sort((x, y) => y.length - x.length);
}

function findPlaces(question, records) {
  const q = ` ${norm(question)} `;
  const found = [];
  for (const p of knownPlaces(records)) {
    const n = norm(p);
    if (q.includes(` ${n} `) && !found.some(f => norm(f).includes(n))) found.push(p);
  }
  if (!found.length) {
    // Fuzzy single-word match for misspellings (e.g. "Kormangala").
    const words = q.trim().split(' ').filter(w => w.length >= 6);
    for (const p of knownPlaces(records)) {
      const n = norm(p);
      if (!n.includes(' ') && words.some(w => lev(w, n) <= 2)) { found.push(p); break; }
    }
  }
  return found;
}

function parseHours(q) {
  const s = q.toLowerCase();
  let m = s.match(/(?:after|past|post)\s*(\d{1,2})\s*(am|pm)?/);
  if (m) {
    let h = Number(m[1]);
    if (m[2] === 'pm' && h < 12) h += 12;
    if (!m[2] && h < 7) h += 12;
    return { hour_from: Math.min(23, h), hour_to: 5 };
  }
  m = s.match(/between\s*(\d{1,2})\s*(am|pm)?\s*(?:and|-|to)\s*(\d{1,2})\s*(am|pm)?/);
  if (m) {
    const conv = (h, ap) => (ap === 'pm' && h < 12 ? h + 12 : ap === 'am' && h === 12 ? 0 : h);
    return { hour_from: conv(Number(m[1]), m[2] || m[4]), hour_to: conv(Number(m[3]), m[4]) };
  }
  if (/\b(late night|night|midnight)\b/.test(s)) return { hour_from: 21, hour_to: 5 };
  if (/\bevening\b/.test(s)) return { hour_from: 17, hour_to: 21 };
  if (/\bmorning\b/.test(s)) return { hour_from: 6, hour_to: 11 };
  return {};
}

export function planWithRules(question, records) {
  const s = question.toLowerCase();
  const f = {};
  if (/fatal|death|deaths|died|killed|deadly|dead/.test(s)) f.severity = 'fatal';
  else if (/serious|injur/.test(s)) f.severity = 'serious';
  else if (/\bminor\b/.test(s)) f.severity = 'minor';
  const zone = ZONES.find(z => new RegExp(`\\b${z.split(' ')[0].toLowerCase()}\\b(?:\\s+(?:zone|bengaluru|bangalore))`).test(s));
  if (zone) f.zone = zone;
  const yr = s.match(/\b(20\d{2})\b/);
  if (yr) { f.from = `${yr[1]}-01-01`; f.to = `${yr[1]}-12-31`; }
  Object.assign(f, parseHours(s));
  const places = findPlaces(question, records);
  if (places.length === 1) f.place = places[0];

  const calls = [];
  if (/compare|\bvs\b|versus/.test(s) && places.length >= 2) calls.push({ tool: 'compare_places', args: { ...f, place: undefined, places } });
  else if (/predict|forecast|future|risk|likely|next (week|month)/.test(s)) calls.push({ tool: 'risk_forecast', args: { place: f.place, zone: f.zone, limit: 5 } });
  else if (/trend|over time|monthly|per month|by month|per year|yearly|increas|decreas|growing|rising/.test(s)) calls.push({ tool: 'trend', args: { ...f, interval: /month/.test(s) ? 'month' : 'year' } });
  else if (/what time|which time|hour|time of day|day of (the )?week|when do|when are|weekend/.test(s)) calls.push({ tool: 'time_pattern', args: f });
  else if (/junction|spot|hotspot|stretch|worst|dangerous|deadliest|most accident|most incident|where/.test(s)) {
    calls.push(f.place || /junction|spot|stretch/.test(s) ? { tool: 'hotspots', args: { ...f, limit: 5 } } : { tool: 'rank_places', args: { ...f, group_by: /zone/.test(s) ? 'zone' : 'area', limit: 8 } });
  } else if (/show|list|recent|latest|example/.test(s)) calls.push({ tool: 'search_incidents', args: { ...f, limit: 5 } });
  else calls.push({ tool: 'count_incidents', args: f });
  if (calls[0].tool === 'count_incidents' && !f.place && !f.zone) calls.push({ tool: 'rank_places', args: { ...f, limit: 5 } });
  return calls;
}

// ── LLM agent ───────────────────────────────────────────────────────────────

function systemPrompt(ctx) {
  const catalog = Object.entries(TOOLS).map(([n, t]) => `- ${n}: ${t.description}`).join('\n');
  const c = ctx.coverage;
  return `You are "Ask BAT", the analytics assistant of the Bangalore Accidents Tracker.
You answer questions about road incidents in Bengaluru using ONLY the tools below. You cannot run SQL.
DATA NOTES: ${c.total} active incidents; ${c.withDate} have a date (${c.firstDate || 'n/a'} to ${c.lastDate || 'n/a'}); ${c.withTime} have a time of day. Place names are free text, so pass the user's wording in "place".
TOOLS:
${catalog}

PROTOCOL — reply with ONE JSON object only:
1) To use tools: {"thought": "short plan", "calls": [{"tool": "<name>", "args": {...}}]}  (at most 3 calls)
2) When you have enough results: {"answer": "plain text, max 110 words", "chart_from": <index of the call whose chart to show, or null>, "followups": ["up to 3 short follow-up questions"]}
RULES: every number in "answer" must come from tool results. "total" counts all severities; only the fatal count is fatal. If data is missing (e.g. few records with a time of day), say so honestly. For questions unrelated to Bengaluru road safety, answer briefly that you can only help with accident data.`;
}

function compactResult(out) {
  const { chart, ...rest } = out || {};
  const s = JSON.stringify(rest);
  return s.length > 2500 ? `${s.slice(0, 2500)}…` : s;
}

async function runAgent(question, ctx, { chat = chatJSON, maxRounds = 3 } = {}) {
  const messages = [{ role: 'system', content: systemPrompt(ctx) }, { role: 'user', content: question }];
  const trace = [];
  const results = [];
  let model = null;
  for (let round = 0; round < maxRounds; round++) {
    const forceAnswer = round === maxRounds - 1;
    if (forceAnswer) messages.push({ role: 'user', content: 'Now give the final answer JSON (no more tool calls).' });
    const reply = await chat({
      messages, temperature: 0.1, maxTokens: 3000, cacheTtlMs: 10 * 60 * 1000,
      validate: (j) => { if (!j || (typeof j.answer !== 'string' && !Array.isArray(j.calls))) throw new Error('Reply is neither calls nor answer'); },
    });
    model = reply.model;
    const j = reply.json;
    messages.push({ role: 'assistant', content: JSON.stringify(j) });
    if (typeof j.answer === 'string' && (!Array.isArray(j.calls) || !j.calls.length || forceAnswer)) {
      return { answer: j.answer.trim(), chartFrom: Number.isInteger(j.chart_from) ? j.chart_from : null, followups: Array.isArray(j.followups) ? j.followups.slice(0, 3).map(String) : [], trace, results, model };
    }
    const calls = (j.calls || []).slice(0, 3);
    const observations = calls.map(c => {
      const out = runTool(ctx, String(c.tool || ''), c.args);
      const idx = results.length;
      results.push({ tool: c.tool, out });
      trace.push({ step: trace.length + 1, thought: j.thought ? String(j.thought).slice(0, 200) : null, tool: c.tool, args: out.filters || c.args, summary: summarize(c.tool, out) });
      return `#${idx} ${c.tool}: ${compactResult(out)}`;
    });
    messages.push({ role: 'user', content: `TOOL RESULTS:\n${observations.join('\n')}` });
  }
  throw new Error('Agent did not finish');
}

function coverage(records) {
  const dated = records.filter(r => r.date).map(r => r.date).sort();
  return { total: records.length, withDate: dated.length, withTime: records.filter(r => r.hour != null).length, firstDate: dated[0] || null, lastDate: dated[dated.length - 1] || null };
}

export async function askBat(question, { records, model = null, useLLM = true, chat = chatJSON } = {}) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) throw new Error('Question is empty');
  const ctx = { records: records.filter(r => r.status === 'active'), model };
  ctx.coverage = coverage(ctx.records);

  if (useLLM && llmAvailable()) {
    try {
      const r = await runAgent(q, ctx, { chat });
      const facts = [...r.results.map(x => x.out), q];
      const bad = unsupportedNumbers(r.answer, facts);
      const sevCount = r.results.find(x => x.out?.bySeverity)?.out.bySeverity;
      const badSev = sevCount ? severityClaimErrors(r.answer, sevCount) : [];
      const chartIdx = r.chartFrom != null && r.results[r.chartFrom]?.out?.chart ? r.chartFrom : r.results.findIndex(x => x.out?.chart);
      const chosen = chartIdx >= 0 ? r.results[chartIdx] : null;
      const grounded = !bad.length && !badSev.length;
      const answer = grounded || !r.results.length ? r.answer : r.results.map(x => summarize(x.tool, x.out)).join(' ');
      return {
        question: q, answer, mode: 'agent', model: r.model, grounded,
        groundingNote: grounded ? null : `The model's wording contained figures not found in the data (${[...bad, ...badSev].slice(0, 3).join(', ')}), so a data-generated answer is shown instead.`,
        chart: chosen?.out?.chart || null, table: chosen ? tableFor(chosen.tool, chosen.out) : null,
        trace: r.trace, followups: r.followups, coverage: ctx.coverage,
      };
    } catch (e) {
      // fall through to rules, but tell the client why
      return { ...runRules(q, ctx), fallbackReason: e.message };
    }
  }
  return runRules(q, ctx);
}

function runRules(q, ctx) {
  const calls = planWithRules(q, ctx.records);
  const results = calls.map(c => ({ tool: c.tool, out: runTool(ctx, c.tool, c.args) }));
  const chosen = results.find(x => x.out?.chart) || null;
  return {
    question: q,
    answer: results.map(x => summarize(x.tool, x.out)).join(' '),
    mode: 'rules', model: null, grounded: true,
    chart: chosen?.out?.chart || null, table: chosen ? tableFor(chosen.tool, chosen.out) : null,
    trace: results.map((x, i) => ({ step: i + 1, thought: 'Rule-based planner (LLM unavailable)', tool: x.tool, args: x.out?.filters || {}, summary: summarize(x.tool, x.out) })),
    followups: ['Which junctions are worst for fatal accidents?', 'Where is risk predicted to be highest?', 'Compare Hebbal vs Silk Board'],
    coverage: ctx.coverage,
  };
}

function tableFor(tool, out) {
  if (!out || out.error) return null;
  switch (tool) {
    case 'rank_places': return { columns: ['Place', 'Total', 'Fatal', 'Serious', 'Minor'], rows: out.rows.map(r => [r.name, r.total, r.fatal, r.serious, r.minor]) };
    case 'hotspots': return { columns: ['Spot', 'Total', 'Fatal', 'Serious', 'Minor'], rows: out.clusters.map(c => [c.name, c.total, c.fatal, c.serious, c.minor]) };
    case 'compare_places': return { columns: ['Place', 'Total', 'Fatal', 'Serious', 'Minor'], rows: out.rows.map(r => [r.place, r.total, r.fatal, r.serious, r.minor]) };
    case 'trend': return { columns: ['Period', 'Total', 'Fatal'], rows: out.series.map(s => [s.period, s.total, s.fatal]) };
    case 'risk_forecast': return { columns: ['Place', 'Level', 'Relative risk', 'Past incidents'], rows: out.cells.map(c => [c.name, c.level.replace('_', ' '), c.relativeRisk, c.pastIncidents]) };
    case 'search_incidents': return { columns: ['Date', 'Severity', 'Place', 'Title'], rows: out.incidents.map(i => [i.date || '—', i.severity, i.place, i.title]) };
    case 'count_incidents': return { columns: ['Severity', 'Count'], rows: [['Fatal', out.bySeverity.fatal], ['Serious', out.bySeverity.serious], ['Minor', out.bySeverity.minor]] };
    default: return null;
  }
}

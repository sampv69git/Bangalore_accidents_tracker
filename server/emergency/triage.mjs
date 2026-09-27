/**
 * Bystander triage → dispatch priority.
 *
 * A bystander answers a few tap-able questions; the answers decide how the
 * alert is prioritised and which hospitals are preferred (critical alerts
 * favour trauma centres). Unknown answers never lower the priority — when in
 * doubt an alert is treated as urgent.
 */
export const PRIORITIES = ['critical', 'urgent', 'standard'];

const TRI = new Set(['yes', 'no', 'unknown']);
const INJURED = new Set(['0', '1', '2', '3+', 'unknown']);
const VEHICLES = new Set(['two_wheeler', 'car', 'auto', 'bus_truck', 'pedestrian', 'cycle', 'other']);
const VEHICLE_LABEL = { two_wheeler: 'two-wheeler', car: 'car', auto: 'auto', bus_truck: 'bus/truck', pedestrian: 'pedestrian', cycle: 'cycle', other: 'other vehicle' };

const tri = (v) => (TRI.has(String(v)) ? String(v) : 'unknown');

export function normalizeTriage(input = {}) {
  const t = input && typeof input === 'object' ? input : {};
  return {
    injured: INJURED.has(String(t.injured)) ? String(t.injured) : 'unknown',
    conscious: tri(t.conscious),
    breathing: tri(t.breathing),
    bleeding: tri(t.bleeding),
    trapped: tri(t.trapped),
    fire: tri(t.fire),
    vehicles: Array.isArray(t.vehicles) ? [...new Set(t.vehicles.map(String).filter(v => VEHICLES.has(v)))].slice(0, 6) : [],
    called_108: t.called_108 === true || t.called_108 === 'yes',
  };
}

/** Combine two triage records (merged reports): keep the more serious answer for each field. */
export function mergeTriage(a = {}, b = {}) {
  const x = normalizeTriage(a), y = normalizeTriage(b);
  const worse = (p, q, bad) => (p === bad || q === bad ? bad : p !== 'unknown' ? p : q);
  const injuredRank = { unknown: -1, 0: 0, 1: 1, 2: 2, '3+': 3 };
  return {
    injured: injuredRank[y.injured] > injuredRank[x.injured] ? y.injured : x.injured,
    conscious: worse(x.conscious, y.conscious, 'no'),
    breathing: worse(x.breathing, y.breathing, 'no'),
    bleeding: worse(x.bleeding, y.bleeding, 'yes'),
    trapped: worse(x.trapped, y.trapped, 'yes'),
    fire: worse(x.fire, y.fire, 'yes'),
    vehicles: [...new Set([...x.vehicles, ...y.vehicles])].slice(0, 6),
    called_108: x.called_108 || y.called_108,
  };
}

/**
 * @param triage normalized triage
 * @param opts.visionSeverity  photo estimate (fatal|serious|minor) — can only raise priority
 * @param opts.reportedSeverity severity chosen on the report form
 * @returns {{ priority: 'critical'|'urgent'|'standard', reasons: string[] }}
 */
export function priorityFromTriage(triage, { visionSeverity = null, reportedSeverity = null } = {}) {
  const t = normalizeTriage(triage);
  const reasons = [];
  if (t.breathing === 'no') reasons.push('not breathing');
  if (t.conscious === 'no') reasons.push('unconscious');
  if (t.bleeding === 'yes') reasons.push('heavy bleeding');
  if (t.trapped === 'yes') reasons.push('person trapped');
  if (t.fire === 'yes') reasons.push('fire / fuel leak');
  if (t.injured === '3+') reasons.push('3 or more injured');
  if (reportedSeverity === 'fatal') reasons.push('reported as fatal');
  if (visionSeverity === 'fatal') reasons.push('photo suggests fatal crash');
  if (reasons.length) return { priority: 'critical', reasons };

  const noInjury = t.injured === '0';
  const minorReport = reportedSeverity === 'minor' && t.injured !== '2';
  if ((noInjury || minorReport) && visionSeverity !== 'serious') {
    return { priority: 'standard', reasons: [noInjury ? 'no one injured' : 'reported as minor'] };
  }
  if (t.injured === '1' || t.injured === '2') reasons.push(`${t.injured} injured`);
  if (visionSeverity === 'serious') reasons.push('photo suggests serious crash');
  if (reportedSeverity === 'serious') reasons.push('reported as serious');
  if (!reasons.length) reasons.push('injuries not yet known');
  return { priority: 'urgent', reasons };
}

/** Legacy severity column (fatal|serious|minor) kept for older consumers. */
export function severityFor(priority, visionSeverity = null) {
  if (visionSeverity === 'fatal') return 'fatal';
  return priority === 'standard' ? 'minor' : 'serious';
}

export function triageSummary(triage) {
  const t = normalizeTriage(triage);
  const parts = [];
  if (t.injured === '0') parts.push('no injuries');
  else if (t.injured !== 'unknown') parts.push(`${t.injured} injured`);
  if (t.breathing === 'no') parts.push('NOT BREATHING');
  if (t.conscious === 'no') parts.push('unconscious');
  else if (t.conscious === 'yes') parts.push('conscious');
  if (t.bleeding === 'yes') parts.push('heavy bleeding');
  if (t.trapped === 'yes') parts.push('trapped');
  if (t.fire === 'yes') parts.push('fire/fuel leak');
  if (t.vehicles.length) parts.push(t.vehicles.map(v => VEHICLE_LABEL[v] || v).join(' + '));
  if (t.called_108) parts.push('108 called');
  return parts.join(' · ') || 'no triage details';
}

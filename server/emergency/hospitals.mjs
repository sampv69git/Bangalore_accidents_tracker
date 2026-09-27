/**
 * Hospital normalisation, classification and de-duplication.
 *
 * Shared by the seeder (seed-hospitals.mjs) and the emergency service so the
 * same rules decide which facilities can receive road-accident emergencies.
 *
 *   facility_type    hospital | clinic | dental | eye | maternity | pediatric |
 *                    ayush | diagnostic | veterinary | skin | cancer |
 *                    mental_health | rehab | specialty
 *   emergency_level  trauma    — major trauma / tertiary centre (curated list)
 *                    emergency — 24x7 casualty expected (OSM emergency=yes,
 *                                multispeciality / government / medical college)
 *                    general   — general hospital, emergency capability unknown
 *                    none      — not suitable for road-accident victims
 *
 * The curated lists are a starting point for Bengaluru and are marked
 * level_source='curated' so an admin can verify or correct them.
 */
import crypto from 'crypto';
import { haversineKm } from '../ai/geo.mjs';

export const EMERGENCY_LEVELS = ['trauma', 'emergency', 'general', 'none'];
export const DISPATCHABLE_LEVELS = ['trauma', 'emergency', 'general'];

// Checked in order; the first match wins.
const FACILITY_RULES = [
  ['veterinary', /\bveterinar|\bvets?\b|\bpets?\b|\banimal|\bcattle/i],
  ['dental', /dental|dentist|\bteeth\b|\btooth|orthodont|\bsmiles?\b|endodont|\bimplant/i],
  ['eye', /\beyes?\b|netra|nethra|ophthalm|\bvision\b|lasik|retina|nayana|cataract|\boptic/i],
  ['ayush', /ayur|homoe?opath|homeo|unani|siddha|naturopath|\byoga\b|panchakarma|herbal|ayush|wellness/i],
  ['diagnostic', /diagnostic|\bscans?\b|laborator|\blabs?\b|patholog|imaging|x-?ray|blood bank|\bmri\b/i],
  ['skin', /\bskin\b|dermat|cosmetic|\bhair\b|aesthetic|slimming|\blaser\b|tricholog/i],
  ['maternity', /\bivf\b|fertility|maternity|\bmatern|\bwomen'?s\b|\bmother|gyna?ec|obstetric|cloud ?nine|motherhood|cradle|\bbirth|femme/i],
  ['cancer', /cancer|oncolog|\bonco\b|kidwai/i],
  ['mental_health', /psychiatr|mental health|de-?addiction|counsel|\bnasha\b|nimhans/i],
  ['rehab', /physio|rehab|palliative|hospice|old age|geriatric care|dialysis/i],
  ['specialty', /tubercul|\btb\b|leprosy|infectious disease|epidemic|chest disease|isolation/i],
  ['pediatric', /\bchild|children|p(a)?ediatric|\bkids?\b|neonat|\bbaby\b|rainbow/i],
];

const HOSPITAL_NAME = /hospital|medical college|institute of medical|health city|multi-?special|super-?special|nursing home|infirmary|\bchc\b|community health|taluk/i;
const CLINIC_NAME = /clinic|polyclinic|dispensary|health cent(er|re)|\bu?phc\b|primary health|family (doctor|physician)|\bdr\.?\s|doctor|\bmedicals?\b|pharmacy|chemist|surgery cent/i;

// Facility types that can never take a road-accident victim, even if a curated
// pattern matches (e.g. "Narayana Nethralaya" is an eye hospital).
const HARD_NON_TRAUMA = new Set(['veterinary', 'dental', 'eye', 'ayush', 'diagnostic', 'skin', 'maternity']);
const NON_EMERGENCY = new Set(['veterinary', 'dental', 'eye', 'ayush', 'diagnostic', 'skin', 'maternity', 'cancer', 'mental_health', 'rehab', 'specialty', 'clinic']);

// Separate OSM entries for parts of a campus (OPD, a department, the nursing
// college) are not where an ambulance should take a victim; the emergency
// block / casualty entrance is.
const SUB_UNIT = /\bopd\b|out-?patient|screening|physiother|rehabilit|psychiatr|department|\bdept\b|pharmacy|blood bank|hostel|quarters|\badmin|nursing college|college of nursing|mortuary/i;
const EMERGENCY_UNIT = /emergency|casualty|trauma/i;

const EMERGENCY_NAME = /multi-?special|super-?special|general hospital|government hospital|govt\.? hospital|district hospital|taluk|\bchc\b|community health|medical college|institute of medical sciences|trauma|emergency|casualty|24\s*[x×*]\s*7|24 ?hrs?\b|accident/i;

/** Major trauma / tertiary centres in Bengaluru with round-the-clock emergency departments. */
export const CURATED_TRAUMA = [
  /victoria hospital/i,
  /sanjay gandhi/i,
  /nimhans|national institute of mental health/i,
  /bowring/i,
  /\bst\.? ?john'?s/i,
  /ramaiah/i,
  /manipal hospital|manipal (north ?side|whitefield)/i,
  /narayana (health|hrudayalaya|multi|institute)|mazumdar shaw/i,
  /\bfortis\b/i,
  /apollo (hospital|speciality|multi)/i,
  /\baster (cmi|rv|whitefield|hospital)/i,
  /\bsakra\b/i,
  /gleneagles|bgs global/i,
  /^sparsh hospital/i,
  /columbia asia/i,
  /vydehi/i,
  /kempegowda institute/i,
  /\bk\.? ?c\.? general/i,
  /jayanagar general/i,
];

/** Hospitals widely known to run a 24x7 casualty that the name rules might miss. */
export const CURATED_EMERGENCY = [
  /st\.? ?philomena/i,
  /baptist hospital/i,
  /^mallya hospital/i,
  /hosmat/i,
  /bhagwan mahaveer jain/i,
  /\besi (model )?hospital|\besic\b/i,
  /sagar hospital/i,
  /rajarajeswari medical/i,
  /sapthagiri (institute|hospital|medical)/i,
  /\bmvj\b/i,
  /vikram hospital/i,
  /chinmaya mission hospital/i,
  /brookefield hospital/i,
];

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|pvt|private|ltd|limited|sri|shri|sree)\b/g, ' ')
    .replace(/hospitals\b/g, 'hospital')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function classifyFacility(name, tags = {}) {
  const hc = `${tags.healthcare || ''} ${tags['healthcare:speciality'] || ''}`.toLowerCase();
  if (/dentist|dentistry/.test(hc)) return 'dental';
  if (/ophthalmology/.test(hc)) return 'eye';
  if (/veterinary/.test(hc)) return 'veterinary';
  const n = String(name || '');
  for (const [type, re] of FACILITY_RULES) if (re.test(n)) return type;
  if (HOSPITAL_NAME.test(n)) return 'hospital';
  if (CLINIC_NAME.test(n)) return 'clinic';
  return 'hospital'; // tagged amenity=hospital in OSM with a plain name
}

/** Decide emergency capability. Returns { facilityType, level, levelSource }. */
export function classifyHospital({ name, tags = {}, beds = null }) {
  let facilityType = classifyFacility(name, tags);
  const n = String(name || '');
  if (SUB_UNIT.test(n) && !EMERGENCY_UNIT.test(n)) return { facilityType, level: 'none', levelSource: 'name-rule' };
  const curated = HARD_NON_TRAUMA.has(facilityType) || facilityType === 'clinic' ? null
    : CURATED_TRAUMA.some(re => re.test(n)) ? 'trauma'
      : CURATED_EMERGENCY.some(re => re.test(n)) ? 'emergency' : null;
  if (curated) {
    if (facilityType !== 'pediatric') facilityType = 'hospital';
    return { facilityType, level: curated, levelSource: 'curated' };
  }
  const emergencyTag = String(tags.emergency || '').toLowerCase();
  if (emergencyTag === 'no') return { facilityType, level: 'none', levelSource: 'osm' };
  if (NON_EMERGENCY.has(facilityType)) return { facilityType, level: 'none', levelSource: 'name-rule' };
  if (emergencyTag === 'yes') return { facilityType, level: 'emergency', levelSource: 'osm' };
  if (EMERGENCY_NAME.test(n) || (Number(beds) >= 50)) return { facilityType, level: 'emergency', levelSource: 'name-rule' };
  return { facilityType, level: 'general', levelSource: 'name-rule' };
}

/**
 * Stable, collision-free id. OSM identity is preferred (survives renames);
 * otherwise a SHA-1 of the full name + rounded position. The previous scheme
 * truncated base64(name|lat|lng) to 20 chars, which only covered ~15 characters
 * of the name, so every "Apollo Hospital" collapsed into a single row.
 */
export function hospitalIdFor({ osmType, osmId, name, lat, lng }) {
  if (osmType && osmId) return `osm_${String(osmType)[0]}${osmId}`;
  const key = `${normalizeName(name)}|${Number(lat).toFixed(5)}|${Number(lng).toFixed(5)}`;
  return 'hosp_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function parseBeds(v) {
  const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : null;
}

function cleanPhone(p) {
  if (!p) return null;
  const first = String(p).split(/[;,/]/)[0].trim();
  return first || null;
}

function finish(base, tags) {
  const { facilityType, level, levelSource } = classifyHospital({ name: base.name, tags, beds: base.beds });
  return {
    ...base,
    id: hospitalIdFor(base),
    facility_type: facilityType,
    emergency_level: level,
    level_source: levelSource,
  };
}

/** Overpass element → hospital row (null when it has no name or position). */
export function fromOsmElement(el) {
  const tags = el.tags || {};
  const name = (tags.name || tags['name:en'] || tags.official_name || '').trim();
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!name || lat == null || lng == null) return null;
  const address = tags['addr:full'] || [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'], tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', ') || null;
  return finish({
    osmType: el.type, osmId: el.id, name, lat: Number(lat), lng: Number(lng),
    phone: cleanPhone(tags.phone || tags['contact:phone'] || tags.telephone || tags['contact:mobile']),
    address,
    beds: parseBeds(tags.beds),
    operator_type: tags['operator:type'] || null,
    emergency_tag: tags.emergency || null,
  }, tags);
}

/** Row from seed-hospitals.json (old {location:"SRID=4326;POINT(lng lat)"} or new {lat,lng}). */
export function fromSeedRow(r) {
  let lat = r.lat, lng = r.lng;
  if ((lat == null || lng == null) && r.location) {
    const m = String(r.location).match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
    if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); }
  }
  if (!r.name || lat == null || lng == null) return null;
  const tags = r.emergency_tag ? { emergency: r.emergency_tag } : {};
  return finish({
    osmType: r.osm_type || null, osmId: r.osm_id || null, name: String(r.name).trim(),
    lat: Number(lat), lng: Number(lng), phone: cleanPhone(r.phone), address: r.address || null,
    beds: parseBeds(r.beds), operator_type: r.operator_type || null, emergency_tag: r.emergency_tag || null,
  }, tags);
}

function completeness(h) {
  return (h.phone ? 2 : 0) + (h.address ? 1 : 0) + (h.osmType === 'way' || h.osmType === 'relation' ? 1 : 0) + (h.emergency_tag ? 1 : 0) + (h.beds ? 1 : 0);
}

/**
 * Merge entries for the same facility: same normalised name within `radiusM`
 * (OSM often has both a node and a building outline for one hospital).
 * Returns { rows, merged } where merged counts dropped duplicates.
 */
export function dedupeHospitals(rows, radiusM = 250) {
  const byName = new Map();
  for (const h of rows) {
    const k = normalizeName(h.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(h);
  }
  const out = [];
  let merged = 0;
  for (const group of byName.values()) {
    const clusters = [];
    for (const h of group.sort((a, b) => completeness(b) - completeness(a))) {
      const c = clusters.find(c => haversineKm(c.lat, c.lng, h.lat, h.lng) * 1000 <= radiusM);
      if (!c) { clusters.push({ ...h }); continue; }
      merged++;
      c.phone = c.phone || h.phone;
      c.address = c.address || h.address;
      c.beds = c.beds || h.beds;
      c.operator_type = c.operator_type || h.operator_type;
      // Keep the most capable classification seen for this facility.
      if (EMERGENCY_LEVELS.indexOf(h.emergency_level) < EMERGENCY_LEVELS.indexOf(c.emergency_level)) {
        c.emergency_level = h.emergency_level;
        c.level_source = h.level_source;
      }
    }
    out.push(...clusters);
  }
  // Two different facilities can still share a hashed id if they have the same
  // name at the same rounded position; keep the first.
  const seen = new Set();
  const unique = out.filter(h => (seen.has(h.id) ? (merged++, false) : seen.add(h.id)));
  return { rows: unique, merged };
}

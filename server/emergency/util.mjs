/**
 * Small shared helpers for the emergency module: capability tokens, ids,
 * coordinate validation, approximate traffic zones.
 */
import crypto from 'crypto';
import { haversineKm, BLR_CENTER } from '../ai/geo.mjs';

/** Random capability token (reporter tracking link / ambulance crew link). Only its hash is stored. */
export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function tokenMatches(token, hashes) {
  if (!token || !Array.isArray(hashes) || !hashes.length) return false;
  const h = Buffer.from(hashToken(token));
  return hashes.some(x => typeof x === 'string' && x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), h));
}

export const newAlertId = () => `alert_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

// Bengaluru metropolitan bounding box (same as report validation).
export const BBOX = { minLat: 12.5, maxLat: 13.5, minLng: 77.0, maxLng: 78.2 };
export const inBbox = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= BBOX.minLat && lat <= BBOX.maxLat && lng >= BBOX.minLng && lng <= BBOX.maxLng;

/**
 * Approximate traffic zone from position: within 4 km of the city centre is
 * Central, otherwise the compass quadrant. Used only to group response metrics.
 */
export function zoneFor(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Other';
  if (haversineKm(lat, lng, BLR_CENTER.lat, BLR_CENTER.lng) < 4) return 'Central';
  const dy = lat - BLR_CENTER.lat;
  const dx = (lng - BLR_CENTER.lng) * Math.cos(BLR_CENTER.lat * Math.PI / 180);
  const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  if (bearing >= 315 || bearing < 45) return 'North';
  if (bearing < 135) return 'East';
  if (bearing < 225) return 'South';
  return 'West';
}

export const minutesBetween = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

export function cleanPhone(v) {
  const s = cleanText(v, 20);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s()-]+$/.test(s)) return null;
  return s;
}

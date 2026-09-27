/**
 * Shared fixtures for the emergency tests: hospitals around Silk Board, a
 * deterministic router (2 min per straight-line km, no network) and a manual clock.
 */
import { haversineKm } from '../../ai/geo.mjs';

export const SCENE = { lat: 12.9170, lng: 77.6230 }; // Silk Board junction

// Offsets in degrees ≈ 0.009 per km.
const at = (dLatKm, dLngKm) => ({ lat: SCENE.lat + dLatKm * 0.009, lng: SCENE.lng + dLngKm * 0.0092 });

export function hospitals() {
  return [
    { id: 'h_dental', name: 'Smile Dental Clinic', ...at(0.1, 0), facility_type: 'dental', emergency_level: 'none' },
    { id: 'h_general', name: 'Near General Hospital', ...at(0.5, 0), emergency_level: 'general', phone: '080 1111 1111' },
    { id: 'h_divert', name: 'Diverting Hospital', ...at(0, 0.7), emergency_level: 'emergency', er_status: 'diverting' },
    { id: 'h_emerg', name: 'Near Emergency Hospital', ...at(1, 0), emergency_level: 'emergency', phone: '080 2222 2222' },
    // Same campus as h_emerg (separate OSM entry for its casualty block).
    { id: 'h_emerg_ward', name: 'Casualty Block', ...at(1.1, 0), emergency_level: 'emergency' },
    { id: 'h_busy', name: 'Busy Emergency Hospital', ...at(0, 1.5), emergency_level: 'emergency', er_status: 'busy' },
    { id: 'h_trauma', name: 'City Trauma Centre', ...at(3, 0), emergency_level: 'trauma', phone: '080 3333 3333' },
    { id: 'h_g2', name: 'General Two', ...at(-2, 0), emergency_level: 'general' },
    { id: 'h_g3', name: 'General Three', ...at(0, -2.5), emergency_level: 'general' },
    { id: 'h_e4', name: 'Emergency Four', ...at(-3, -1), emergency_level: 'emergency' },
    { id: 'h_e5', name: 'Emergency Five', ...at(4, 2), emergency_level: 'emergency' },
    { id: 'h_far', name: 'Far Trauma', ...at(12, 0), emergency_level: 'trauma' },
  ];
}

export function fakeRouter() {
  const calls = { table: 0, route: 0, matrix: 0 };
  const drive = (a, b) => {
    const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
    return { distanceKm: Math.round(km * 13.5) / 10, durationMin: Math.round(km * 20) / 10, source: 'osrm' };
  };
  return {
    calls,
    async toDestination(origins, dest) { calls.table++; return origins.map(o => drive(o, dest)); },
    async route(from, to) { calls.route++; return { ...drive(from, to), coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }; },
    async matrix(sources, dests) { calls.matrix++; return sources.map(s => dests.map(d => drive(s, d).durationMin)); },
    trafficFactor: () => 1,
  };
}

export function clock(start = '2026-09-20T04:30:00Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(sec) { t += sec * 1000; },
  };
}

export const silentLogger = { log() {}, warn() {}, error() {} };

/**
 * HTTP tests for the emergency routes using the real createEmergencyFeatures
 * wiring with the in-memory store, a fake router and fake Supabase auth.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEmergencyFeatures } from '../emergency/index.mjs';
import { createMemoryStore } from '../emergency/store-memory.mjs';
import { hospitals, fakeRouter, clock, SCENE, silentLogger } from './fixtures/emergency-fixtures.js';

// Bearer tokens → users (stands in for supabase.auth.getUser).
const USERS = {
  'tok-general': { id: 'u-general', email: 'er@general.test', role: 'hospital' },
  'tok-emerg': { id: 'u-emerg', email: 'er@emerg.test', role: 'hospital' },
  'tok-unlinked': { id: 'u-unlinked', email: 'new@hospital.test', role: 'hospital' },
  'tok-citizen': { id: 'u-citizen', email: 'citizen@test', role: 'user' },
  'tok-admin': { id: 'u-admin', email: 'admin@test', role: 'admin' },
};

let app, features, store, clk, roles;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  clk = clock();
  store = createMemoryStore({ hospitals: hospitals(), now: clk.now });
  await store.linkHospitalUser({ userId: 'u-general', hospitalId: 'h_general' });
  await store.linkHospitalUser({ userId: 'u-emerg', hospitalId: 'h_emerg' });
  roles = {};
  features = createEmergencyFeatures({
    store, router: fakeRouter(), logger: silentLogger, now: clk.now,
    verifyUser: async (t) => USERS[t] || null,
    userDirectory: {
      findByEmail: async (email) => Object.values(USERS).find(u => u.email === email) || null,
      setRole: async (id, role) => { roles[id] = role; },
    },
    limits: { sos: 1000, photo: 1000 },
  });
  await features.init();
  app = express();
  app.use(express.json());
  features.registerRoutes(app);
});

describe('public directory', () => {
  it('lists hospitals with capability stats and filters by level', async () => {
    const all = await request(app).get('/api/hospitals');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(12);
    expect(all.body.stats.byLevel).toMatchObject({ trauma: 2, none: 1 });
    expect(all.body.hospitals[0]).not.toHaveProperty('email');
    const trauma = await request(app).get('/api/hospitals?level=trauma');
    expect(trauma.body.hospitals.map(h => h.id).sort()).toEqual(['h_far', 'h_trauma']);
    const search = await request(app).get('/api/hospitals?q=dental');
    expect(search.body.total).toBe(1);
  });

  it('nearest hospitals by drive time, emergency-capable only', async () => {
    const res = await request(app).get(`/api/hospitals/near?lat=${SCENE.lat}&lng=${SCENE.lng}&limit=3&eta=1&emergency=1`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map(h => h.id)).not.toContain('h_dental');
    expect(res.body[0].eta_min).toBeLessThanOrEqual(res.body[1].eta_min);
    expect((await request(app).get('/api/hospitals/near?lat=x')).status).toBe(400);
  });
});

describe('SOS → accept → track', () => {
  let alertId, token;

  it('creates an alert anonymously and returns a tracking link', async () => {
    const res = await request(app).post('/api/emergency').send({ ...SCENE, triage: { injured: '2', bleeding: 'yes' }, reporter_phone: '98450 12345', note: 'Bike under bus' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'new', priority: 'critical', merged: false });
    expect(res.body.trackUrl).toBe(`track.html?id=${res.body.alertId}&t=${res.body.trackToken}`);
    expect(res.body.hospitals.length).toBeGreaterThan(0);
    alertId = res.body.alertId;
    token = res.body.trackToken;
  });

  it('keeps the legacy {photo_url, lat, lng} contract working', async () => {
    const res = await request(app).post('/api/emergency').send({ photo_url: 'https://example.com/scene.jpg', lat: 13.03, lng: 77.59 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('alertId');
    expect(Array.isArray(res.body.hospitals)).toBe(true);
  });

  it('validates input', async () => {
    expect((await request(app).post('/api/emergency').send({ lat: 28.6, lng: 77.2 })).status).toBe(400);
    expect((await request(app).post('/api/emergency').send({})).status).toBe(400);
  });

  it('tracking requires the token', async () => {
    expect((await request(app).get(`/api/emergency/${alertId}`)).status).toBe(404);
    expect((await request(app).get(`/api/emergency/${alertId}?token=wrong`)).status).toBe(404);
    const res = await request(app).get(`/api/emergency/${alertId}?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: alertId, status: 'new', hospitals_notified: 3, can_cancel: true });
    expect(res.body).not.toHaveProperty('reporter_phone');
  });

  it('reporter can add details and a photo', async () => {
    const upd = await request(app).patch(`/api/emergency/${alertId}?token=${token}`).send({ triage: { trapped: 'yes' }, note: 'Driver trapped' });
    expect(upd.status).toBe(200);
    expect(upd.body.triage.trapped).toBe('yes');
    const photo = await request(app).post(`/api/emergency/${alertId}/photo?token=${token}`).set('Content-Type', 'image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(photo.status).toBe(200);
    expect(photo.body.photo_count).toBe(1);
    const bad = await request(app).post(`/api/emergency/${alertId}/photo?token=${token}`).set('Content-Type', 'text/plain').send('hi');
    expect(bad.status).toBe(415);
  });

  it('hospital endpoints require a hospital responder', async () => {
    expect((await request(app).get('/api/hospital/alerts')).status).toBe(401);
    expect((await request(app).get('/api/hospital/alerts').set(auth('bogus'))).status).toBe(401);
    expect((await request(app).get('/api/hospital/alerts').set(auth('tok-citizen'))).status).toBe(403);
    const me = await request(app).get('/api/hospital/me').set(auth('tok-citizen'));
    expect(me.body).toMatchObject({ isResponder: false, linked: false });
  });

  it('unlinked hospital accounts see nothing and cannot accept', async () => {
    const me = await request(app).get('/api/hospital/me').set(auth('tok-unlinked'));
    expect(me.body).toMatchObject({ isResponder: true, linked: false, hospital: null });
    expect((await request(app).get('/api/hospital/alerts').set(auth('tok-unlinked'))).body).toEqual([]);
    const acc = await request(app).post(`/api/hospital/alerts/${alertId}/accept`).set(auth('tok-unlinked'));
    expect(acc.status).toBe(403);
    expect(acc.body.code).toBe('not_linked');
  });

  it('linked hospital sees the alert, its photo and the reporter phone', async () => {
    const list = await request(app).get('/api/hospital/alerts').set(auth('tok-emerg'));
    expect(list.status).toBe(200);
    const a = list.body.find(x => x.id === alertId);
    expect(a).toBeTruthy();
    expect(a.my_target).toBeTruthy();
    expect(a.reporter_phone).toBe('98450 12345');
    const photo = await request(app).get(`/api/hospital/alerts/${alertId}/photo`).set(auth('tok-emerg'));
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it('first accept wins over HTTP too', async () => {
    const a = await request(app).post(`/api/hospital/alerts/${alertId}/accept`).set(auth('tok-emerg'));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'accepted', accepted_by_me: true });
    const b = await request(app).post(`/api/hospital/alerts/${alertId}/accept`).set(auth('tok-general'));
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ code: 'already_taken', by: 'Near Emergency Hospital' });
  });

  it('crew link can share location and update status; reporter sees it', async () => {
    const link = await request(app).post(`/api/hospital/alerts/${alertId}/crew-link`).set(auth('tok-emerg'));
    expect(link.status).toBe(200);
    const crewToken = link.body.token;
    expect((await request(app).get(`/api/crew/${alertId}?token=nope`)).status).toBe(404);
    const view = await request(app).get(`/api/crew/${alertId}?token=${crewToken}`);
    expect(view.body).toMatchObject({ id: alertId, reporter_phone: '98450 12345', hospital: { id: 'h_emerg' } });

    const loc = await request(app).post(`/api/crew/${alertId}/location?token=${crewToken}`).send({ lat: SCENE.lat + 0.01, lng: SCENE.lng, accuracy: 12 });
    expect(loc.status).toBe(200);
    expect(loc.body.status).toBe('dispatched');

    const track = await request(app).get(`/api/emergency/${alertId}?token=${token}`);
    expect(track.body.ambulance).toMatchObject({ lat: SCENE.lat + 0.01, accuracy_m: 12 });
    expect(track.body.accepted_hospital).toMatchObject({ name: 'Near Emergency Hospital', phone: '080 2222 2222' });
    expect(track.body.can_cancel).toBe(true);

    const route = await request(app).get(`/api/emergency/${alertId}/route?token=${token}`);
    expect(route.body.kind).toBe('ambulance');

    const onScene = await request(app).post(`/api/crew/${alertId}/status?token=${crewToken}`).send({ status: 'on_scene' });
    expect(onScene.body.status).toBe('on_scene');
    const back = await request(app).post(`/api/crew/${alertId}/status?token=${crewToken}`).send({ status: 'dispatched' });
    expect(back.status).toBe(409);

    const cancel = await request(app).post(`/api/emergency/${alertId}/cancel?token=${token}`).send({ reason: 'oops' });
    expect(cancel.status).toBe(409); // too late once the ambulance is there
  });

  it('ER status toggle', async () => {
    const res = await request(app).patch('/api/hospital/me/status').set(auth('tok-general')).send({ er_status: 'diverting', note: 'CT down' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ er_status: 'diverting', er_status_note: 'CT down' });
    const near = await request(app).get(`/api/hospitals/near?lat=${SCENE.lat}&lng=${SCENE.lng}&limit=2`);
    expect(near.body[0]).toMatchObject({ id: 'h_dental' });
    await request(app).patch('/api/hospital/me/status').set(auth('tok-general')).send({ er_status: 'unknown' });
  });
});

describe('admin', () => {
  it('links a hospital account by email and grants the role', async () => {
    expect((await request(app).post('/api/admin/hospital-users').set(auth('tok-emerg')).send({})).status).toBe(403);
    const res = await request(app).post('/api/admin/hospital-users').set(auth('tok-admin')).send({ email: 'new@hospital.test', hospital_id: 'h_trauma' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user_id: 'u-unlinked', hospital_id: 'h_trauma', hospital_name: 'City Trauma Centre' });
    expect(roles['u-unlinked']).toBe('hospital');
    const me = await request(app).get('/api/hospital/me').set(auth('tok-unlinked'));
    expect(me.body).toMatchObject({ linked: true, hospital: { id: 'h_trauma' } });
    expect((await request(app).post('/api/admin/hospital-users').set(auth('tok-admin')).send({ email: 'ghost@x', hospital_id: 'h_trauma' })).status).toBe(404);
    const list = await request(app).get('/api/admin/hospital-users').set(auth('tok-admin'));
    expect(list.body.map(u => u.user_id)).toContain('u-unlinked');
    const del = await request(app).delete('/api/admin/hospital-users/u-unlinked').set(auth('tok-admin'));
    expect(del.status).toBe(200);
    expect(roles['u-unlinked']).toBeNull();
  });

  it('corrects a hospital record', async () => {
    const res = await request(app).patch('/api/admin/hospitals/h_g2').set(auth('tok-admin')).send({ emergency_level: 'emergency', phone: '080 4444 4444', verified: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emergency_level: 'emergency', level_source: 'admin', verified: true, phone: '080 4444 4444' });
    expect((await request(app).patch('/api/admin/hospitals/h_g2').set(auth('tok-admin')).send({ emergency_level: 'super' })).status).toBe(400);
    expect((await request(app).patch('/api/admin/hospitals/h_g2').set(auth('tok-admin')).send({ webhook_url: 'http://insecure' })).status).toBe(400);
  });

  it('sees every alert in control-room scope', async () => {
    const res = await request(app).get('/api/hospital/alerts?scope=all').set(auth('tok-admin'));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('analytics', () => {
  it('response metrics exclude drills unless asked', async () => {
    await features.service.createAlert({ lat: 12.99, lng: 77.70 }, { isDrill: true });
    const real = await request(app).get('/api/emergency-metrics?days=7');
    const withDrills = await request(app).get('/api/emergency-metrics?days=7&drills=1');
    expect(real.status).toBe(200);
    expect(withDrills.body.summary.total).toBe(real.body.summary.total + 1);
    expect(real.body.daily).toHaveLength(7);
  });

  it('coverage is computed in the background, then served', async () => {
    const first = await request(app).get('/api/coverage');
    expect(['computing', 'ready']).toContain(first.body.status);
    await features.coverage.compute();
  });
});

/**
 * Dispatch service: ranking, escalation, first-to-accept, lifecycle, live
 * location, duplicate merging and what each audience is allowed to see.
 * Runs on the in-memory store with a fake router and a manual clock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStore } from '../emergency/store-memory.mjs';
import { createEmergencyService } from '../emergency/service.mjs';
import { createBus } from '../emergency/bus.mjs';
import { hospitals, fakeRouter, clock, SCENE, silentLogger } from './fixtures/emergency-fixtures.js';

let store, svc, clk, bus, notified, published;

function setup(config = {}, extra = {}) {
  clk = clock();
  store = createMemoryStore({ hospitals: hospitals(), now: clk.now });
  bus = createBus();
  published = [];
  bus.subscribe(m => published.push(m));
  notified = [];
  svc = createEmergencyService({
    store, bus, router: fakeRouter(), logger: silentLogger, now: clk.now,
    notify: async (alert, hs) => { notified.push({ alert, ids: hs.map(h => h.id) }); return hs.map(h => ({ hospital_id: h.id })); },
    config: { roundTimeoutSec: 90, ...config },
    ...extra,
  });
}

const responder = async (hospitalId, extra = {}) => ({ userId: `u_${hospitalId}`, role: 'hospital', isAdmin: false, hospital: await store.getHospital(hospitalId), ...extra });
const admin = { userId: 'admin1', role: 'admin', isAdmin: true, hospital: null };

beforeEach(() => setup());

describe('createAlert + ranking', () => {
  it('notifies the 3 best emergency-capable hospitals, never clinics or diverting ERs', async () => {
    const { alert, token, hospitals: ranked } = await svc.createAlert({ ...SCENE, triage: { injured: '1' } });
    await svc.idle();
    expect(alert.status).toBe('new');
    expect(alert.priority).toBe('urgent');
    expect(token).toMatch(/^[\w-]{20,}$/);
    const targets = await store.getTargets(alert.id);
    const ids = targets.map(t => t.hospital_id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('h_dental');
    expect(ids).not.toContain('h_divert');
    expect(ids).toEqual(expect.arrayContaining(['h_general', 'h_emerg']));
    expect(ids).not.toContain('h_emerg_ward'); // same campus as h_emerg
    expect(ranked.length).toBeGreaterThan(3);
    expect(notified[0].ids.sort()).toEqual(ids.slice().sort());
    expect((await store.getAlert(alert.id)).escalation_round).toBe(1);
  });

  it('prefers trauma centres for critical patients', async () => {
    const { alert } = await svc.createAlert({ ...SCENE, triage: { breathing: 'no' } });
    expect(alert.priority).toBe('critical');
    const ids = (await store.getTargets(alert.id)).map(t => t.hospital_id);
    expect(ids).toContain('h_trauma');
    expect(ids).not.toContain('h_general'); // closest, but a general hospital gets a 10-minute penalty
  });

  it('penalises busy ERs', async () => {
    const ranked = await svc.rankCandidates({ ...SCENE, priority: 'urgent' });
    const pos = (id) => ranked.findIndex(c => c.hospital.id === id);
    expect(pos('h_busy')).toBeGreaterThan(pos('h_trauma'));
  });

  it('rejects locations outside Bengaluru', async () => {
    await expect(svc.createAlert({ lat: 28.6, lng: 77.2 })).rejects.toMatchObject({ status: 400 });
  });

  it('merges a second report of the same crash instead of alerting again', async () => {
    const first = await svc.createAlert({ ...SCENE, triage: { injured: '1' }, note: 'car hit bike' });
    clk.advance(60);
    const second = await svc.createAlert({ lat: SCENE.lat + 0.0005, lng: SCENE.lng, triage: { conscious: 'no' }, note: 'rider not moving' });
    expect(second.merged).toBe(true);
    expect(second.alert.id).toBe(first.alert.id);
    expect(second.token).not.toBe(first.token);
    expect(second.alert).toMatchObject({ report_count: 2, priority: 'critical' });
    expect(second.alert.note).toContain('rider not moving');
    expect(svc.trackAllowed(second.alert, first.token)).toBe(true);
    expect(svc.trackAllowed(second.alert, second.token)).toBe(true);
    expect(notified).toHaveLength(1);
  });

  it('does not merge reports far apart or after the window', async () => {
    const a = await svc.createAlert({ ...SCENE });
    const b = await svc.createAlert({ lat: SCENE.lat + 0.01, lng: SCENE.lng });
    clk.advance(16 * 60);
    const c = await svc.createAlert({ ...SCENE });
    expect(new Set([a.alert.id, b.alert.id, c.alert.id]).size).toBe(3);
  });
});

describe('escalation', () => {
  it('notifies the next hospitals when nobody accepts in time, then gives up', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    const round1 = (await store.getTargets(alert.id)).map(t => t.hospital_id);

    clk.advance(60);
    await svc.sweep();
    expect((await store.getTargets(alert.id))).toHaveLength(3); // not due yet

    clk.advance(31);
    await svc.sweep();
    const all = await store.getTargets(alert.id);
    const round2 = all.filter(t => t.round === 2).map(t => t.hospital_id);
    expect(round2).toHaveLength(3);
    expect(round2.some(id => round1.includes(id))).toBe(false);
    expect(all.filter(t => t.round === 1).every(t => t.response === 'missed')).toBe(true);

    clk.advance(91); await svc.sweep(); // round 3
    clk.advance(91); await svc.sweep(); // exhausted
    const final = await store.getAlert(alert.id);
    expect(final.escalation_round).toBe(3);
    expect(final.escalation_exhausted_at).toBeTruthy();
    expect(final.status).toBe('new'); // still open: any hospital may still take it
    expect((await store.getEvents(alert.id)).map(e => e.type)).toContain('escalation_exhausted');
  });

  it('escalates immediately when every notified hospital declines', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    for (const t of await store.getTargets(alert.id)) await svc.declineAlert(alert.id, await responder(t.hospital_id), 'No ICU bed');
    await svc.idle();
    const targets = await store.getTargets(alert.id);
    expect(targets.filter(t => t.round === 2)).toHaveLength(3);
    expect(targets.filter(t => t.response === 'declined')).toHaveLength(3);
  });
});

describe('accept + lifecycle', () => {
  it('lets exactly one hospital win a race to accept', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    const [a, b] = await Promise.allSettled([
      svc.acceptAlert(alert.id, await responder('h_general')),
      svc.acceptAlert(alert.id, await responder('h_emerg')),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(b.reason).toMatchObject({ status: 409, code: 'already_taken', by: 'Near General Hospital' });
    const final = await store.getAlert(alert.id);
    expect(final).toMatchObject({ status: 'accepted', accepted_hospital_id: 'h_general' });
    expect(final.ambulance_eta_min).toBeGreaterThan(0);
    const targets = await store.getTargets(alert.id);
    expect(targets.find(t => t.hospital_id === 'h_general').response).toBe('accepted');
    expect(targets.filter(t => t.response === 'missed').length).toBe(2);
    // accepting again is idempotent for the winner
    await expect(svc.acceptAlert(alert.id, await responder('h_general'))).resolves.toMatchObject({ status: 'accepted' });
  });

  it('any nearby hospital may step in, even if it was not notified', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    await svc.acceptAlert(alert.id, await responder('h_far'));
    expect((await store.getTargets(alert.id)).find(t => t.hospital_id === 'h_far')).toMatchObject({ round: 0, response: 'accepted' });
  });

  it('requires a linked hospital to accept', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    await expect(svc.acceptAlert(alert.id, { userId: 'x', role: 'hospital', hospital: null })).rejects.toMatchObject({ status: 403, code: 'not_linked' });
  });

  it('moves forward through the lifecycle only, by the owning hospital', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    const me = await responder('h_emerg');
    const actor = { kind: 'hospital', hospital: me.hospital };
    await svc.acceptAlert(alert.id, me);
    await expect(svc.setStatus(alert.id, 'dispatched', { kind: 'hospital', hospital: (await responder('h_general')).hospital })).rejects.toMatchObject({ status: 403 });
    await svc.setStatus(alert.id, 'dispatched', actor);
    clk.advance(420);
    await svc.setStatus(alert.id, 'on_scene', actor);
    await expect(svc.setStatus(alert.id, 'dispatched', actor)).rejects.toMatchObject({ status: 409 });
    clk.advance(600);
    await svc.setStatus(alert.id, 'transporting', actor);
    clk.advance(900);
    const closed = await svc.setStatus(alert.id, 'closed', actor, { outcome: 'handed_over' });
    expect(closed).toMatchObject({ status: 'closed', close_outcome: 'handed_over' });
    expect(closed.on_scene_at - closed.created_at).toBe(420000);
    expect((await store.getEvents(alert.id)).filter(e => e.type === 'status').map(e => e.data.status)).toEqual(['dispatched', 'on_scene', 'transporting', 'closed']);
  });

  it('release hands the case back and re-dispatches to other hospitals', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    const me = await responder('h_general');
    await svc.acceptAlert(alert.id, me);
    await svc.releaseAlert(alert.id, me, 'Ambulance broke down');
    await svc.idle();
    const a = await store.getAlert(alert.id);
    expect(a).toMatchObject({ status: 'new', accepted_hospital_id: null, escalation_round: 2 });
    const targets = await store.getTargets(alert.id);
    expect(targets.find(t => t.hospital_id === 'h_general')).toMatchObject({ response: 'declined' });
    expect(targets.filter(t => t.round === 2).map(t => t.hospital_id)).not.toContain('h_general');
  });

  it('reporter can cancel; hospitals then cannot accept', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    await svc.cancelAlert(alert.id, { kind: 'reporter' }, 'Patient taken by autorickshaw');
    await expect(svc.acceptAlert(alert.id, await responder('h_emerg'))).rejects.toMatchObject({ status: 409, code: 'cancelled' });
    await expect(svc.cancelAlert(alert.id, { kind: 'reporter' })).rejects.toMatchObject({ status: 409 });
    await svc.sweep();
    expect((await store.getTargets(alert.id)).filter(t => t.round === 2)).toHaveLength(0);
  });
});

describe('live ambulance location', () => {
  it('auto-marks dispatched, computes ETA and throttles re-routing', async () => {
    const router = fakeRouter();
    setup({ etaRefreshSec: 30 }, { router });
    const { alert } = await svc.createAlert({ ...SCENE });
    const me = await responder('h_emerg');
    await svc.acceptAlert(alert.id, me);
    const actor = { kind: 'hospital', hospital: me.hospital };

    const r1 = await svc.updateLocation(alert.id, actor, { lat: SCENE.lat + 0.018, lng: SCENE.lng });
    expect(r1.status).toBe('dispatched');
    expect(r1.eta_min).toBeCloseTo(4, 0);
    const routesAfterFirst = router.calls.route;

    clk.advance(10);
    const r2 = await svc.updateLocation(alert.id, actor, { lat: SCENE.lat + 0.012, lng: SCENE.lng });
    expect(router.calls.route).toBe(routesAfterFirst); // within 30 s: estimated, not re-routed
    expect(r2.eta_min).toBeLessThan(r1.eta_min);

    clk.advance(31);
    await svc.updateLocation(alert.id, actor, { lat: SCENE.lat + 0.005, lng: SCENE.lng });
    expect(router.calls.route).toBe(routesAfterFirst + 1);

    const a = await store.getAlert(alert.id);
    expect(a.ambulance_lat).toBeCloseTo(SCENE.lat + 0.005, 6);
    const types = (await store.getEvents(alert.id)).map(e => e.type);
    expect(types).toContain('tracking_started');
    expect(types.filter(t => t === 'tracking_started')).toHaveLength(1);
  });

  it('crew links authorise only their alert', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    const me = await responder('h_emerg');
    await svc.acceptAlert(alert.id, me);
    const { token, url } = await svc.issueCrewLink(alert.id, { kind: 'hospital', hospital: me.hospital });
    expect(url).toContain(`crew.html?id=${alert.id}&t=${token}`);
    const fresh = await store.getAlert(alert.id);
    expect(svc.crewAllowed(fresh, token)).toBe(true);
    expect(svc.crewAllowed(fresh, 'nope')).toBe(false);
    expect(svc.trackAllowed(fresh, token)).toBe(false);
  });
});

describe('views and privacy', () => {
  it('reporter view hides declines; responder view hides the reporter phone from uninvolved hospitals', async () => {
    const { alert } = await svc.createAlert({ ...SCENE, reporter_phone: '+91 98450 12345', triage: { injured: '2' } });
    const targetIds = (await store.getTargets(alert.id)).map(t => t.hospital_id);
    await svc.declineAlert(alert.id, await responder(targetIds[0]), 'No beds');

    const pub = await svc.publicView(await store.getAlert(alert.id));
    expect(pub).toMatchObject({ status: 'new', reporter_phone_set: true, can_cancel: true, hospitals_notified: 3 });
    expect(JSON.stringify(pub)).not.toContain('No beds');
    expect(JSON.stringify(pub)).not.toContain('98450');
    expect(pub.timeline.map(e => e.type)).not.toContain('declined');
    expect(pub.hospitals[0]).toHaveProperty('phone');

    const involved = await svc.responderDetail(alert.id, await responder(targetIds[1]));
    expect(involved.reporter_phone).toBe('+91 98450 12345');
    expect(involved.my_target).toMatchObject({ round: 1, response: 'pending' });

    // A hospital nearby but not notified can see the open alert, without the phone number.
    const bystanderHospital = targetIds.includes('h_g2') ? 'h_g3' : 'h_g2';
    const outsider = await svc.responderDetail(alert.id, await responder(bystanderHospital));
    expect(outsider.reporter_phone).toBeNull();
    expect(outsider.my_target).toBeNull();

    // After someone else accepts, that outsider no longer sees it.
    await svc.acceptAlert(alert.id, await responder(targetIds[1]));
    await expect(svc.responderDetail(alert.id, await responder(bystanderHospital))).rejects.toMatchObject({ status: 404 });
    expect((await svc.listForResponder(admin, { scope: 'all' })).map(a => a.id)).toContain(alert.id);
  });

  it('publishes bus events for live pages', async () => {
    const { alert } = await svc.createAlert({ ...SCENE });
    expect(published.some(m => m.type === 'alert' && m.alertId === alert.id)).toBe(true);
    const me = await responder('h_emerg');
    await svc.setErStatus(me, 'busy', 'Two trauma cases');
    expect(published).toContainEqual({ type: 'hospital', hospitalId: 'h_emerg' });
    expect(await store.getHospital('h_emerg')).toMatchObject({ er_status: 'busy', er_status_note: 'Two trauma cases' });
    await expect(svc.setErStatus(me, 'closed')).rejects.toMatchObject({ status: 400 });
  });
});

describe('photos', () => {
  it('stores photos, runs the vision estimate in the background and can raise priority', async () => {
    setup({}, {
      imageProcessor: async (b) => Buffer.concat([Buffer.from('JPEG:'), b]),
      vision: async () => ({ severity: 'fatal', description: 'Overturned car, person on road' }),
    });
    const { alert } = await svc.createAlert({ ...SCENE, triage: { injured: '1' } });
    expect(alert.priority).toBe('urgent');
    await svc.addPhoto(alert.id, Buffer.from('abc'), 'image/png');
    await svc.idle();
    const a = await store.getAlert(alert.id);
    expect(a).toMatchObject({ photo_count: 1, vision_severity: 'fatal', priority: 'critical', severity: 'fatal' });
    const photo = await store.getPhoto(alert.id);
    expect(photo.mime).toBe('image/jpeg');
    expect(photo.bytes.toString()).toBe('JPEG:abc');
    await expect(svc.addPhoto(alert.id, Buffer.from('x'), 'image/gif')).rejects.toMatchObject({ status: 415 });
  });

  it('a failed vision call changes nothing', async () => {
    setup({}, { vision: async () => null });
    const { alert } = await svc.createAlert({ ...SCENE, triage: { injured: '1' } });
    await svc.addPhoto(alert.id, Buffer.from('abc'), 'image/jpeg');
    await svc.idle();
    const a = await store.getAlert(alert.id);
    expect(a.priority).toBe('urgent');
    expect(a.vision_severity ?? null).toBeNull();
  });
});

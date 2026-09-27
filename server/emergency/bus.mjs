/**
 * In-process pub/sub for real-time updates (Server-Sent Events).
 * Messages: { type: 'alert', alertId } | { type: 'hospital', hospitalId }.
 * Single-server only; with several API instances this would move to Postgres
 * LISTEN/NOTIFY or Supabase Realtime.
 */
import { EventEmitter } from 'events';

export function createBus() {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  return {
    publish(msg) { em.emit('msg', msg); },
    subscribe(fn) { em.on('msg', fn); return () => em.off('msg', fn); },
    listenerCount() { return em.listenerCount('msg'); },
  };
}

/** Start an SSE response. Returns { send(event, data), onClose(fn) }. */
export function openStream(req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 4000\n\n');
  const cleanups = [];
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  cleanups.push(() => clearInterval(heartbeat));
  req.on('close', () => { while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } } });
  return {
    send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    onClose(fn) { cleanups.push(fn); },
  };
}

/** Coalesce bursts of updates for the same key into one call after `ms`. */
export function debouncer(ms = 150) {
  const timers = new Map();
  return {
    run(key, fn) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
    },
    clear() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

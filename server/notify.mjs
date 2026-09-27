// Read lazily: this module is imported before index.js loads .env.
const env = () => ({
  TWILIO_SID: process.env.TWILIO_SID || '',
  TWILIO_TOKEN: process.env.TWILIO_TOKEN || '',
  TWILIO_FROM: process.env.TWILIO_FROM || '',
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'no-reply@bat.local',
});

export function buildAlertMessage(alert) {
  const maps = `https://www.google.com/maps?q=${alert.lat},${alert.lng}`;
  const level = (alert.priority || alert.severity || 'urgent').toUpperCase();
  return [
    `${alert.is_drill ? '[DRILL] ' : ''}BAT Emergency (${level})`,
    alert.triage_summary || '',
    alert.address || '',
    maps,
    alert.console_url ? `Accept: ${alert.console_url}` : `Alert ID: ${alert.id}`,
  ].filter(Boolean).join('\n');
}

/** Fields safe to send to hospital webhooks (no reporter tokens). */
function webhookAlert(alert) {
  const { track_token_hashes, crew_token_hashes, reporter_id, ...rest } = alert;
  return rest;
}

async function postWebhook(url, payload) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(id);
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendSmsViaTwilio(to, body) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = env();
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return { ok: false, error: 'Twilio not configured' };
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const form = new URLSearchParams();
    form.append('From', TWILIO_FROM);
    form.append('To', to);
    form.append('Body', body);
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: controller.signal });
    clearTimeout(id);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendEmailViaSendGrid(to, subject, text) {
  const { SENDGRID_API_KEY, FROM_EMAIL } = env();
  if (!SENDGRID_API_KEY) return { ok: false, error: 'SendGrid not configured' };
  try {
    const url = 'https://api.sendgrid.com/v3/mail/send';
    const body = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL },
      subject,
      content: [{ type: 'text/plain', value: text }]
    };
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(id);
    const txt = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: txt };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function notifyHospitals(alert, hospitals = []) {
  const msg = buildAlertMessage(alert);
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, SENDGRID_API_KEY } = env();
  const results = [];
  await Promise.all(hospitals.map(async (h) => {
    try {
      const resEntry = { hospital_id: h.id, name: h.name };
      // webhook first
      if (h.webhook_url) {
        const payload = { alert: webhookAlert(alert), hospital: { id: h.id, name: h.name, phone: h.phone, email: h.email } };
        const r = await postWebhook(h.webhook_url, payload);
        resEntry.webhook = r;
      }
      // SMS if phone present
      if (h.phone && TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
        const sms = await sendSmsViaTwilio(h.phone, msg);
        resEntry.sms = sms;
      }
      // Email if email present
      if (h.email && SENDGRID_API_KEY) {
        const em = await sendEmailViaSendGrid(h.email, `BAT Emergency: ${alert.priority || alert.severity || 'urgent'}`, msg);
        resEntry.email = em;
      }
      results.push(resEntry);
    } catch (e) {
      results.push({ hospital_id: h.id, error: e.message });
    }
  }));
  return results;
}

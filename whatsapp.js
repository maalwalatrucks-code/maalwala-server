// whatsapp.js — thin wrapper around Meta's WhatsApp Cloud API.
//
// IMPORTANT REALITY CHECK (not a policy choice, a platform fact):
// The Cloud API can only send to individual phone numbers that have
// messaged your business number first (a 24-hour "session"), or to
// numbers that have opted in to receive an approved template message
// outside that window. It CANNOT post into a WhatsApp group — Meta
// does not expose that to any business account. So "broadcast" here
// means "send to everyone on your opted-in contact list", one API
// call per contact.

const GRAPH_VERSION = 'v20.0';

function isConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendTextMessage(toNumber, body) {
  if (!isConfigured()) {
    throw new Error('WhatsApp Cloud API is not configured — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env');
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `WhatsApp send failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

module.exports = { isConfigured, sendTextMessage };

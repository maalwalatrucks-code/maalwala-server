// SMS OTP delivery via MSG91 — replaces WhatsApp for login codes.
// WhatsApp's Cloud API requires Meta business approval for authentication
// templates (a process we hit real, repeated blockers on); MSG91 needs
// only a DLT-registered SMS template, which is faster and more reliable
// for a login flow like this. See chat notes for the reasoning.
//
// MSG91 generates and verifies the OTP itself — this module is a thin
// wrapper around their /otp and /otp/verify endpoints. It does not know
// or store the code; server.js just relays the phone number and, later,
// whatever the user typed back to sms.verifyOtp().

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

function isConfigured() {
  return Boolean(MSG91_AUTH_KEY && MSG91_TEMPLATE_ID);
}

// phone: 10-digit Indian mobile number, no country code, no leading zero.
async function sendOtp(phone) {
  const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(MSG91_TEMPLATE_ID)}&mobile=91${phone}&otp_expiry=10`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (data.type !== 'success') {
    throw new Error(data.message || `MSG91 send failed (status ${res.status})`);
  }
  return data;
}

async function verifyOtp(phone, otp) {
  const url = `https://control.msg91.com/api/v5/otp/verify?mobile=91${phone}&otp=${encodeURIComponent(otp)}`;
  const res = await fetch(url, { headers: { authkey: MSG91_AUTH_KEY } });
  const data = await res.json().catch(() => ({}));
  return data.type === 'success';
}

module.exports = { isConfigured, sendOtp, verifyOtp };

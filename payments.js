// payments.js — Razorpay (collect from shipper) + RazorpayX (payout to
// transporter) integration for the escrow booking system.
//
// Security note: every payment status change in this app is driven by
// a signature-verified webhook from Razorpay, never by a button the
// user clicks. That's the single most important property of this file
// — see verifyWebhookSignature(). Never add a "mark as paid" endpoint
// that a client can call directly; that would defeat the whole point
// of using a payment gateway in the first place.

const crypto = require('crypto');

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function isPaymentsConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
function isPayoutsConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAYX_ACCOUNT_NUMBER);
}

function authHeader() {
  const token = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

async function razorpayRequest(path, method, body) {
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay request failed (HTTP ${res.status})`);
  }
  return data;
}

// ---------- Collecting payment from the shipper ----------
// Creates a Payment Link for the FULL booking amount (we collect 100%
// upfront — see the reasoning in chat: this removes the "second
// payment the shipper can refuse" problem entirely).
async function createPaymentLink({ bookingId, amountRupees, description, customerName, customerPhone }) {
  if (!isPaymentsConfigured()) {
    throw new Error('Razorpay is not configured on this server yet (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET).');
  }
  const data = await razorpayRequest('/payment_links', 'POST', {
    amount: Math.round(amountRupees * 100), // paise
    currency: 'INR',
    description,
    customer: { name: customerName || 'Maalwala user', contact: customerPhone || undefined },
    notify: { sms: Boolean(customerPhone), email: false },
    reference_id: bookingId,
    callback_url: undefined, // frontend polls booking status instead of relying on redirect
    notes: { bookingId },
  });
  return { paymentLinkId: data.id, shortUrl: data.short_url };
}

// Verifies a webhook actually came from Razorpay — this is what makes
// "payment succeeded" trustworthy instead of something fake-able by
// just calling our own API with a crafted request.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || ''));
  } catch (e) {
    return false; // length mismatch etc. — treat as invalid, never throw here
  }
}

// ---------- Paying the transporter (RazorpayX) ----------
// Creates a "Contact" + "Fund Account" for a transporter the first
// time we pay them, then reuses it. The transporter never sees or
// touches Razorpay directly — they just gave us their UPI ID or bank
// details once, same as giving anyone your account number to be paid.
async function getOrCreateFundAccount({ name, phone, upiId, bankAccount, bankIfsc }) {
  const contact = await razorpayRequest('/contacts', 'POST', {
    name, contact: phone, type: 'vendor',
  });
  const fundAccountBody = upiId
    ? { contact_id: contact.id, account_type: 'vpa', vpa: { address: upiId } }
    : { contact_id: contact.id, account_type: 'bank_account', bank_account: { name, ifsc: bankIfsc, account_number: bankAccount } };
  const fundAccount = await razorpayRequest('/fund_accounts', 'POST', fundAccountBody);
  return fundAccount.id;
}

async function sendPayout({ fundAccountId, amountRupees, purpose, referenceId }) {
  if (!isPayoutsConfigured()) {
    throw new Error('RazorpayX payouts are not configured on this server yet (missing RAZORPAYX_ACCOUNT_NUMBER).');
  }
  return razorpayRequest('/payouts', 'POST', {
    account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
    fund_account_id: fundAccountId,
    amount: Math.round(amountRupees * 100),
    currency: 'INR',
    mode: 'UPI', // falls back to IMPS automatically for bank_account fund accounts on Razorpay's side
    purpose: purpose || 'payout',
    queue_if_low_balance: true,
    reference_id: referenceId,
  });
}

module.exports = {
  isPaymentsConfigured, isPayoutsConfigured,
  createPaymentLink, verifyWebhookSignature,
  getOrCreateFundAccount, sendPayout,
};

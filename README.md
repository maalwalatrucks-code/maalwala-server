# Maalwala API server

A small Express backend so loads, trucks, groups, your business
profile, and Sprint 4's records (invoices, expenses, fuel,
maintenance, salary, POD) persist on a server instead of just one
browser's local storage — plus an integration with Meta's official
WhatsApp Cloud API for one-click broadcast to people who've opted in.

## 1. Run the backend

```bash
cd server
npm install
cp .env.example .env
npm start
```

The API runs on `http://localhost:4000` by default. Leave the
WhatsApp variables in `.env` blank for now — everything except the
official broadcast works without them.

**Worth knowing:** this stores data as JSON files on disk. That's
reliable when you run it yourself or on a host with persistent
storage, but on Render's free tier specifically, that disk gets
wiped on every restart or redeploy — so treat it as good for testing
and demos, not yet for records you can't afford to lose. If that
becomes a real problem later, moving to a free persistent database
(MongoDB Atlas is the common choice) is a contained change to just
this file, whenever you're ready for it.

## 2. Point the frontend at it

Open `config.js` (next to `index.html`) and set:

```js
window.MAALWALA_API_BASE = 'http://localhost:4000';
```

Reload the site. It now reads/writes through the API. If the API is
unreachable it quietly falls back to the old local-storage-only mode
so the site never breaks.

## 3. (Optional) Set up the official WhatsApp Cloud API broadcast

This is only needed if you want "post a load → automatically message
everyone who opted in" with zero manual taps. Group posting is not
possible through this API — see the note in `whatsapp.js`.

1. Create a Meta developer account at developers.facebook.com and a
   new app of type "Business".
2. Add the "WhatsApp" product to the app. Meta gives you a free test
   number to start.
3. From **WhatsApp → API Setup**, copy the **Temporary access token**
   and **Phone number ID** into `.env` as `WHATSAPP_TOKEN` and
   `WHATSAPP_PHONE_NUMBER_ID`. (The temporary token expires in 24
   hours — for production, generate a permanent token under System
   Users in Meta Business Settings.)
4. Pick your own random string for `WHATSAPP_VERIFY_TOKEN` in `.env`.
5. Deploy this server somewhere with a public HTTPS URL (Render,
   Railway, Fly.io, a VPS, etc. — `localhost` won't work here since
   Meta needs to reach it). In **WhatsApp → Configuration → Webhook**,
   set the callback URL to `https://your-domain/api/whatsapp/webhook`
   and the verify token to the same string from step 4.
6. Subscribe the webhook to the `messages` field.
7. Test it: message your test number the word **JOIN** from your own
   phone. You should get a reply and see yourself added to
   `server/data/contacts.json`.
8. Now when you post a load with "broadcast to opted-in contacts"
   checked, everyone who's opted in gets it automatically.

### Why this can't reach WhatsApp groups
Meta's WhatsApp Business Platform is built to message individual
customers who've messaged your business first or opted in — it has
no endpoint for posting into a group chat, for any business, at any
approval tier. That's a platform boundary, not something this code
is choosing to withhold. If your real goal is reaching the trucking
WhatsApp groups you're already a member of, the manual "open group,
message pre-filled, you tap send" flow already in the app is the
realistic way to do that without risking your number.

## Data storage

Everything is stored as JSON files under `server/data/` — good
enough to get started, and every route only calls the methods
exported from `store.js` (`store.loads.all()`, `store.loads.insert()`,
etc.), so swapping in a real database later never means rewriting
the routes themselves.

/**
 * Boodschappenheld – Push Worker
 * Stuurt web-push meldingen als een gevolgd product in prijs daalt of in de bonus komt.
 *
 * KV namespace: PUSH_SUBS  (maak aan met: wrangler kv:namespace create PUSH_SUBS)
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (zie generate-vapid-keys.mjs)
 *
 * Endpoints:
 *   POST /subscribe        → body: { subscription, watchlist } — abonneer/update
 *   POST /unsubscribe      → body: { endpoint } — meld af
 *   POST /sync-watchlist   → body: { endpoint, watchlist } — ververs gevolgde producten
 *   GET  /vapid-public-key → geeft de publieke VAPID-key terug
 *
 * Cron trigger (zie wrangler.toml): checkt dagelijks alle abonnementen tegen de
 * actuele winkeldata en stuurt een melding bij prijsdaling/bonus/laagste-in-30-dagen.
 *
 * Kanttekening: handmatige winkels (Kruidvat/Etos) staan alleen lokaal op het device
 * van de gebruiker — de worker kan die prijzen niet zien en checkt ze dus niet mee.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DATA_BASE = 'https://boodschappen.herogames.nl/data';
const STORES = ['ah', 'jumbo', 'plus', 'lidl'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ── base64url helpers ──
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ── VAPID JWT (ES256) ──
async function importVapidKeys(env) {
  // Verwacht: VAPID_PUBLIC_KEY (base64url, uncompressed P-256 point, 65 bytes) en
  // VAPID_PRIVATE_KEY (base64url, 32-byte raw 'd' scalar) — zoals web-push / generate-vapid-keys.mjs uitgeeft.
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const d = env.VAPID_PRIVATE_KEY;
  const jwk = { kty: 'EC', crv: 'P-256', x, y, d, ext: true, key_ops: ['sign'] };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidHeaders(endpoint, env) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@herogames.nl' };
  const enc = s => bytesToB64url(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const key = await importVapidKeys(env);
  const sigDer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  // WebCrypto ECDSA geeft raw (r||s, elk 32 bytes) terug voor P-256 — precies wat JWS verwacht.
  const jwt = `${unsigned}.${bytesToB64url(new Uint8Array(sigDer))}`;
  return {
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
  };
}

// ── RFC 8291: aes128gcm payload-encryptie voor web push ──
async function encryptPayload(payloadObj, subscription) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const clientPub = b64urlToBytes(subscription.keys.p256dh);
  const clientAuth = b64urlToBytes(subscription.keys.auth);

  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));

  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeyPair.privateKey, 256));

  const hkdfKey = async (secret, salt, info, len) => {
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
    return new Uint8Array(bits);
  };

  // PRK van het auth secret + shared ECDH secret
  const authInfo = new TextEncoder().encode('WebPush: info\0');
  const prkInfo = concatBytes(authInfo, clientPub, serverPubRaw);
  const ikm = await hkdfKey(sharedSecret, clientAuth, prkInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdfKey(ikm, salt, cekInfo, 16);
  const nonce = await hkdfKey(ikm, salt, nonceInfo, 12);

  // Padding: 2-byte lengte-prefix (0x0000 → geen padding) vóór het plaintext, plus 1-byte delimiter 0x02
  const padded = concatBytes(plaintext, new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Header: salt(16) + recordSize(4, big-endian) + keyIdLen(1) + keyId(serverPubRaw, 65)
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, recordSize, new Uint8Array([serverPubRaw.length]), serverPubRaw);

  return concatBytes(header, ciphertext);
}

async function sendPush(subscription, payloadObj, env) {
  const body = await encryptPayload(payloadObj, subscription);
  const vapidHeaders = await buildVapidHeaders(subscription.endpoint, env);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body,
  });
  return res;
}

// ── Prijscheck ──
async function checkWatchlistAlerts(watchlist) {
  const today = new Date().toISOString().slice(0, 10);
  const alerts = [];
  const dataCache = {};
  for (const w of watchlist) {
    if (!STORES.includes(w.storeId)) continue; // handmatige winkels niet checkbaar server-side
    if (!dataCache[w.storeId]) {
      try {
        const res = await fetch(`${DATA_BASE}/${w.storeId}.json`);
        dataCache[w.storeId] = res.ok ? await res.json() : { products: [] };
      } catch { dataCache[w.storeId] = { products: [] }; }
    }
    const p = dataCache[w.storeId].products?.find(x => String(x.id || x.name) === String(w.pid));
    if (!p || typeof p.price !== 'number') continue;
    let eff = p.price, bonus = null;
    if (p.bonus && p.bonus.start && p.bonus.end && p.bonus.start <= today && today <= p.bonus.end) {
      bonus = p.bonus;
      if (typeof p.bonus_price === 'number') eff = p.bonus_price;
    }
    const drop = w.priceAtAdd > 0 ? w.priceAtAdd - eff : 0;
    if (bonus || drop > 0.01) {
      alerts.push({ name: p.name, storeId: w.storeId, price: eff, bonus: !!bonus, drop: +drop.toFixed(2) });
    }
  }
  return alerts;
}

async function runDailyCheck(env) {
  const list = await env.PUSH_SUBS.list();
  for (const key of list.keys) {
    const raw = await env.PUSH_SUBS.get(key.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    if (!entry.watchlist?.length) continue;
    const alerts = await checkWatchlistAlerts(entry.watchlist);
    if (!alerts.length) continue;
    const title = alerts.length === 1 ? '📉 Prijsalert' : `📉 ${alerts.length} prijsalerts`;
    const body = alerts.slice(0, 3).map(a => a.bonus ? `${a.name}: nu in de bonus (${a.price.toFixed(2)})` : `${a.name}: ${a.drop.toFixed(2)} goedkoper`).join(' · ');
    try {
      const res = await sendPush(entry.subscription, { title, body, url: '/' }, env);
      if (res.status === 404 || res.status === 410) await env.PUSH_SUBS.delete(key.name); // subscription verlopen
    } catch (e) { console.error('push failed', key.name, e.message); }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/vapid-public-key') {
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body.subscription?.endpoint) return json({ error: 'subscription vereist' }, 400);
      const key = bytesToB64url(new TextEncoder().encode(body.subscription.endpoint)).slice(0, 200);
      await env.PUSH_SUBS.put(key, JSON.stringify({ subscription: body.subscription, watchlist: body.watchlist || [], updatedAt: Date.now() }));
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/sync-watchlist') {
      let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body.endpoint) return json({ error: 'endpoint vereist' }, 400);
      const key = bytesToB64url(new TextEncoder().encode(body.endpoint)).slice(0, 200);
      const existing = await env.PUSH_SUBS.get(key);
      if (!existing) return json({ error: 'Niet gevonden — abonneer eerst' }, 404);
      const entry = JSON.parse(existing);
      entry.watchlist = body.watchlist || [];
      entry.updatedAt = Date.now();
      await env.PUSH_SUBS.put(key, JSON.stringify(entry));
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body.endpoint) return json({ error: 'endpoint vereist' }, 400);
      const key = bytesToB64url(new TextEncoder().encode(body.endpoint)).slice(0, 200);
      await env.PUSH_SUBS.delete(key);
      return json({ ok: true });
    }

    // Handmatig triggeren voor testen: GET /run-check (niet gelinkt vanuit de app)
    if (request.method === 'GET' && url.pathname === '/run-check') {
      await runDailyCheck(env);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyCheck(env));
  },
};

/**
 * Boodschappenheld – Deellijst Worker
 * Slaat gedeelde lijsten op in KV en geeft ze terug.
 *
 * KV namespace: SHARES  (maak aan met: wrangler kv:namespace create SHARES)
 *
 * Endpoints:
 *   POST /share           → maak nieuwe deelcode; body: { items:[], name? }
 *   GET  /share/:id       → haal lijst op
 *   PUT  /share/:id       → update lijst; body: { items:[], updatedAt }
 *   DELETE /share/:id     → verwijder lijst
 *
 * Deelcodes verlopen automatisch na 30 dagen (KV TTL).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const TTL = 60 * 60 * 24 * 30; // 30 dagen in seconden

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function randId(len = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const b of arr) id += chars[b % chars.length];
  return id;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    // POST /share  — maak nieuwe deelcode
    if (request.method === 'POST' && parts[0] === 'share' && !parts[1]) {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const id = randId();
      const payload = { id, items: body.items || [], name: body.name || '', updatedAt: Date.now(), createdAt: Date.now() };
      await env.SHARES.put(id, JSON.stringify(payload), { expirationTtl: TTL });
      return json(payload, 201);
    }

    // GET /share/:id
    if (request.method === 'GET' && parts[0] === 'share' && parts[1]) {
      const val = await env.SHARES.get(parts[1]);
      if (!val) return json({ error: 'Niet gevonden of verlopen' }, 404);
      return json(JSON.parse(val));
    }

    // PUT /share/:id  — update lijst
    if (request.method === 'PUT' && parts[0] === 'share' && parts[1]) {
      const existing = await env.SHARES.get(parts[1]);
      if (!existing) return json({ error: 'Niet gevonden of verlopen' }, 404);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const prev = JSON.parse(existing);
      const payload = { ...prev, items: body.items ?? prev.items, updatedAt: Date.now() };
      await env.SHARES.put(parts[1], JSON.stringify(payload), { expirationTtl: TTL });
      return json(payload);
    }

    // DELETE /share/:id
    if (request.method === 'DELETE' && parts[0] === 'share' && parts[1]) {
      await env.SHARES.delete(parts[1]);
      return json({ ok: true });
    }

    // POST /report  — sla foutmelding op (voor later inzien)
    if (request.method === 'POST' && parts[0] === 'report') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const reports = JSON.parse(await env.SHARES.get('__reports__') || '[]');
      reports.unshift({ ...body, id: randId(6) });
      if (reports.length > 200) reports.splice(200);
      await env.SHARES.put('__reports__', JSON.stringify(reports), { expirationTtl: TTL * 12 });
      return json({ ok: true });
    }

    // GET /reports  — haal alle foutmeldingen op
    if (request.method === 'GET' && parts[0] === 'reports') {
      const reports = JSON.parse(await env.SHARES.get('__reports__') || '[]');
      return json(reports);
    }

    return json({ error: 'Not found' }, 404);
  },
};

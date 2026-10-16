// Test de AI-Worker zonder de Claude API echt aan te roepen.
// globalThis.fetch wordt vervangen door een stub: de échte SDK bouwt het
// verzoek, de test legt vast wat er verstuurd zou worden en geeft een
// nagebootst API-antwoord terug. Kost dus niets.
// Run: npm test  (in worker/)

import worker from './worker.js';

const ORIGIN = 'http://localhost:5180';
const env = { ANTHROPIC_API_KEY: 'sk-ant-test-niet-echt' };

let pass = 0, fail = 0;
function check(naam, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${naam}`); }
  else { fail++; console.log(`  ✗ ${naam}\n      verwacht: ${e}\n      gekregen: ${a}`); }
}

// ── fetch-stub ──────────────────────────────────────────────────────────────
let laatsteVerzoek = null;
let antwoord = null;
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  laatsteVerzoek = {
    url: String(url),
    headers: Object.fromEntries(headers.entries()),
    body: init.body ? JSON.parse(init.body) : null,
  };
  const { status = 200, body, extraHeaders = {} } = antwoord;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...extraHeaders },
  });
};

function apiBericht({ text, stop_reason = 'end_turn', model = 'claude-opus-5-5' }) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model,
    content: text === null ? [] : [{ type: 'text', text }],
    stop_reason, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 120, output_tokens: 80 },
  };
}

async function vraag(body) {
  const res = await worker.fetch(new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, json: await res.json(), cors: res.headers.get('Access-Control-Allow-Origin') };
}

console.log('\nAI-Worker\n' + '─'.repeat(60));

// 1. Combi: het verzoek dat de SDK opbouwt
antwoord = { body: apiBericht({ text: JSON.stringify({ suggesties: [
  { naam: 'rundergehakt', reden: 'voor spaghetti bolognese' },
  { naam: 'parmezaanse kaas', reden: 'over de pasta' },
] }) }) };
let r = await vraag({ mode: 'combi', list: [{ name: 'Spaghetti' }, { name: 'Tomaten' }, { name: 'Uien' }] });
const v = laatsteVerzoek;
// De beta-variant zet er ?beta=true achter
check('combi: naar de Messages API', new URL(v.url).pathname, '/v1/messages');
check('combi: model claude-opus-5-5', v.body.model, 'claude-opus-5-5');
check('combi: effort low', v.body.output_config?.effort, 'low');
check('combi: gestructureerde uitvoer (json_schema)', v.body.output_config?.format?.type, 'json_schema');
check('combi: schema eist suggesties', v.body.output_config?.format?.schema?.required, ['suggesties']);
check('combi: terugval bij weigering', v.body.fallbacks, 'default');
check('combi: bijbehorende beta-header', (v.headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01'), true);
check('combi: geen thinking-parameter (staat op dit model altijd aan)', 'thinking' in v.body, false);
check('combi: API-key in header, niet in body', v.headers['x-api-key'], env.ANTHROPIC_API_KEY);
check('combi: lijst in het bericht', v.body.messages[0].content.includes('- Spaghetti\n- Tomaten'), true);
check('combi: antwoord 200', r.status, 200);
check('combi: suggesties terug', r.json.suggesties, [
  { naam: 'rundergehakt', reden: 'voor spaghetti bolognese' },
  { naam: 'parmezaanse kaas', reden: 'over de pasta' },
]);
check('combi: CORS voor de app', r.cors, ORIGIN);

// 2. Combi: maximaal 4, lege namen eruit
antwoord = { body: apiBericht({ text: JSON.stringify({ suggesties: [
  { naam: 'a', reden: '' }, { naam: '  ', reden: 'x' }, { naam: 'b', reden: '' },
  { naam: 'c', reden: '' }, { naam: 'd', reden: '' }, { naam: 'e', reden: '' },
] }) }) };
r = await vraag({ mode: 'combi', list: [{ name: 'x' }] });
check('combi: hooguit 4, lege naam gefilterd', r.json.suggesties.map(s => s.naam), ['a', 'b', 'c', 'd']);

// 3. Combi: weigering levert gewoon niets op
antwoord = { body: apiBericht({ text: null, stop_reason: 'refusal' }) };
r = await vraag({ mode: 'combi', list: [{ name: 'x' }] });
check('combi: weigering → lege lijst, geen fout', [r.status, r.json.suggesties, r.json.geweigerd], [200, [], true]);

// 4. Combi: afgekapt antwoord is een fout, geen half-geparste JSON
antwoord = { body: apiBericht({ text: '{"suggesties": [{"naam": "rund', stop_reason: 'max_tokens' }) };
r = await vraag({ mode: 'combi', list: [{ name: 'x' }] });
check('combi: max_tokens → foutmelding', r.status, 502);

// 5. Bestaande modus: zelfde model als voorheen, geen nieuwe parameters
antwoord = { body: apiBericht({ text: '**🍝 Bolognese**', model: 'claude-haiku-4-5-20251001' }) };
r = await vraag({ mode: 'recept', list: [{ name: 'Pasta', qty: 1 }] });
check('recept: ongewijzigd model', laatsteVerzoek.body.model, 'claude-haiku-4-5-20251001');
check('recept: geen output_config', 'output_config' in laatsteVerzoek.body, false);
check('recept: tekst terug', r.json.text, '**🍝 Bolognese**');

// 6. Deals: prijs komt nu wél aan bij het model (was d.price, app stuurt price_now)
antwoord = { body: apiBericht({ text: 'ok', model: 'claude-sonnet-4-6' }) };
await vraag({ mode: 'deals', deals: [{ name: 'Kaas', store: 'AH', mechanism: '1+1', price_now: 3.5, price_was: 7 }] });
check('deals: prijs in de prompt', laatsteVerzoek.body.messages[0].content.includes('(€3.50 i.p.v. €7.00)'), true);

// 7. Rate limit van de API wordt een nette 429
antwoord = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'te veel' } },
             extraHeaders: { 'retry-after-ms': '0', 'x-should-retry': 'false' } };
r = await vraag({ mode: 'combi', list: [{ name: 'x' }] });
check('429 → 429 met Nederlandse melding', [r.status, typeof r.json.error], [429, 'string']);

// 8. Ping en onbekende modus
r = await vraag({ mode: 'ping' });
check('ping meldt combi-model', r.json.models?.combi, 'claude-opus-5-5');
r = await vraag({ mode: 'bestaatniet' });
check('onbekende modus → 400', r.status, 400);

globalThis.fetch = echteFetch;
console.log('─'.repeat(60));
console.log(`${pass} geslaagd, ${fail} gefaald.`);
process.exit(fail ? 1 : 0);

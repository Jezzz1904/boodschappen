import worker from './index.js';

// KV-stub zodat de handler kan draaien zonder Cloudflare
const store = new Map();
const env = { SHARES: {
  get: async k => store.get(k) ?? null,
  put: async (k, v) => { store.set(k, v); },
  delete: async k => { store.delete(k); },
}};

let pass = 0, fail = 0;
const check = (naam, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${naam}${ok ? '' : `\n      verwacht: ${expected}\n      gekregen: ${actual}`}`);
};

console.log('\nShare-worker CORS\n' + '─'.repeat(60));

// 1. Preflight staat x-report-token toe
const pre = await worker.fetch(new Request('https://w/report', { method: 'OPTIONS' }), env);
const allow = pre.headers.get('Access-Control-Allow-Headers');
check('preflight staat Content-Type toe', /content-type/i.test(allow), true);
check('preflight staat X-Report-Token toe', /x-report-token/i.test(allow), true);
check('preflight heeft Max-Age', pre.headers.get('Access-Control-Max-Age'), '86400');

// 2. Melden werkt met het juiste token
const post = await worker.fetch(new Request('https://w/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-report-token': 'bheld-report-v1' },
  body: JSON.stringify({ type: 'wrong-match', item: 'tomaten', product: 'PLUS Tomaten ketchup', store: 'Plus' }),
}), env);
check('melden geeft 200', post.status, 200);
check('melden geeft CORS-header terug', post.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-Report-Token');

// 3. Zonder token nog steeds geweigerd
const geen = await worker.fetch(new Request('https://w/report', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}), env);
check('zonder token nog steeds 401', geen.status, 401);

// 4. Melding is opgeslagen en terug te lezen
const lees = await worker.fetch(new Request('https://w/reports', {
  method: 'GET', headers: { 'x-report-token': 'bheld-report-v1' },
}), env);
const reports = await lees.json();
check('melding opgeslagen', reports.length, 1);
check('juiste product bewaard', reports[0].product, 'PLUS Tomaten ketchup');

// 5. Deel-endpoints blijven werken
const maak = await worker.fetch(new Request('https://w/share', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ name: 'Melk' }] }),
}), env);
const gemaakt = await maak.json();
check('lijst delen geeft 201', maak.status, 201);
const haal = await worker.fetch(new Request('https://w/share/' + gemaakt.id), env);
const opgehaald = await haal.json();
check('gedeelde lijst terug te halen', opgehaald.items[0].name, 'Melk');

console.log('─'.repeat(60));
console.log(`${pass} geslaagd, ${fail} gefaald.`);
process.exit(fail ? 1 : 0);

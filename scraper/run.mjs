// Run alle scrapers voor de zoeklijst en schrijf data/*.json
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ah from './ah.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');

// Default zoeklijst — meest gekochte NL boodschappen.
// Later vervangen door wat de gebruiker in PWA-historie heeft.
const DEFAULT_QUERIES = [
  'halfvolle melk', 'volle melk', 'karnemelk', 'yoghurt naturel', 'magere yoghurt',
  'kwark', 'vla', 'roomboter', 'jong belegen kaas', 'mozzarella',
  'tijgerbrood', 'volkorenbrood', 'bruin brood', 'wit brood', 'krentenbol',
  'eieren', 'kipfilet', 'gehakt half om half', 'spek', 'zalmfilet',
  'tomaat', 'komkommer', 'paprika rood', 'sla', 'ui', 'knoflook',
  'aardappel', 'wortel', 'broccoli', 'banaan', 'appel elstar',
  'spaghetti', 'penne', 'basmati rijst', 'olijfolie', 'pesto rood',
  'koffie bonen', 'thee', 'cola', 'spa rood', 'sinaasappelsap',
  'wc papier', 'keukenpapier', 'allesreiniger', 'afwasmiddel',
  'shampoo', 'tandpasta', 'deodorant',
];

async function loadQueries() {
  try {
    const list = JSON.parse(await readFile(resolve(DATA_DIR, 'queries.json'), 'utf-8'));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return DEFAULT_QUERIES;
}

async function scrapeStore(name, fns, queries) {
  console.log(`\n══ ${name.toUpperCase()} ══`);
  const out = [];
  for (const q of queries) {
    try {
      const results = await fns.search(q, 8);
      const best = fns.pickBest(results, q);
      if (best) {
        const bonusTag = best.onSale ? ` 🟡 ${best.bonusMechanism || best.promotionType || 'AANBIEDING'}` : '';
        console.log(`  ✓ ${q.padEnd(28)} → ${best.name} | €${best.priceNow}${bonusTag}`);
        out.push({ query: q, ...best });
      } else {
        console.log(`  ✗ ${q.padEnd(28)} → geen match`);
        out.push({ query: q, notFound: true });
      }
      await new Promise(r => setTimeout(r, 250)); // beleefd zijn
    } catch (e) {
      console.log(`  ! ${q.padEnd(28)} → ${e.message}`);
      out.push({ query: q, error: e.message });
    }
  }
  return out;
}

(async () => {
  const queries = await loadQueries();
  console.log(`Scrapen voor ${queries.length} zoektermen...`);
  await mkdir(DATA_DIR, { recursive: true });

  const results = {};
  results.ah = await scrapeStore('ah', ah, queries);

  const summary = {
    updatedAt: new Date().toISOString(),
    stores: ['ah'],
    queryCount: queries.length,
    counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [
      k, { ok: v.filter(r => !r.notFound && !r.error).length, onSale: v.filter(r => r.onSale).length }
    ])),
  };

  await writeFile(resolve(DATA_DIR, 'ah-products.json'),  JSON.stringify(results.ah, null, 2));
  await writeFile(resolve(DATA_DIR, 'last-updated.json'), JSON.stringify(summary,    null, 2));

  console.log('\n── samenvatting ──');
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

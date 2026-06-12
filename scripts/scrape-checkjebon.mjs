// Haalt de checkjebon dataset (alle NL supermarkten, dagelijks geupdate) en
// schrijft per winkel een geslankt data/<store>.json in hetzelfde schema als ah.json.
// checkjebon heeft GEEN bonus/aanbieding-data — alleen reguliere prijzen.
// Voor AH gebruiken we onze eigen mobile-API scraper (die wel bonus heeft).
//
// Run lokaal:  node scripts/scrape-checkjebon.mjs jumbo
//              node scripts/scrape-checkjebon.mjs jumbo plus lidl

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://raw.githubusercontent.com/supermarkt/checkjebon/main/data/supermarkets.json';

// Welke winkels mag je opvragen (voorkomt typo's, en AH sluiten we expres uit)
const ALLOWED = new Set(['jumbo', 'plus', 'lidl', 'dirk', 'dekamarkt', 'hoogvliet', 'aldi', 'coop', 'spar', 'vomar', 'poiesz']);

async function main() {
  const stores = process.argv.slice(2).map(s => s.toLowerCase());
  if (!stores.length) {
    console.error('Gebruik: node scripts/scrape-checkjebon.mjs <store> [store...]');
    console.error('Bv: node scripts/scrape-checkjebon.mjs jumbo');
    process.exit(1);
  }
  for (const s of stores) {
    if (!ALLOWED.has(s)) {
      console.error(`Onbekende/niet-toegestane winkel: "${s}". Toegestaan: ${[...ALLOWED].join(', ')}`);
      process.exit(1);
    }
  }

  console.log('checkjebon dataset ophalen...');
  const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download faalde: HTTP ${res.status}`);
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error('Onverwacht dataformaat (geen array)');

  await mkdir(resolve(ROOT, 'data'), { recursive: true });

  for (const storeName of stores) {
    const store = all.find(s => (s.n || '').toLowerCase() === storeName);
    if (!store || !Array.isArray(store.d)) {
      console.warn(`! "${storeName}" niet gevonden in dataset — overgeslagen`);
      continue;
    }
    // checkjebon product: { n:naam, l:link-slug, p:prijs, s:formaat }
    const products = store.d
      .filter(p => p && p.n && typeof p.p === 'number')
      .map(p => {
        const o = { id: `${storeName.slice(0, 2)}_${p.l}`, name: p.n, price: p.p };
        if (p.s) o.unit = p.s;
        return o;
      });

    const out = {
      store: storeName,
      source: 'checkjebon',
      base_url: store.u || null,
      scraped_at: new Date().toISOString(),
      has_bonus: false,
      product_count: products.length,
      products,
    };
    const path = resolve(ROOT, `data/${storeName}.json`);
    await writeFile(path, JSON.stringify(out), 'utf8');
    const mb = (JSON.stringify(out).length / 1024 / 1024).toFixed(2);
    console.log(`✓ ${storeName.padEnd(10)} → ${products.length} producten (${mb} MB) → data/${storeName}.json`);
  }
}

main().catch(err => {
  console.error('FOUT:', err.message);
  process.exit(1);
});

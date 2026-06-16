/**
 * Boodschappenheld – Prijsgeschiedenis bijhouden
 *
 * Leest de huidige winkeldata en voegt de prijzen toe aan
 * data/price-history.json. Bewaart maximaal 60 dagen.
 * Slaat alleen op als de prijs veranderd is (compact diff).
 *
 * Formaat price-history.json:
 * {
 *   "ah:1234567": { name: "Halfvolle melk 1L", entries: [[timestamp, price], ...] },
 *   ...
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const STORES = [
  { id: 'ah',    file: './data/ah.json'    },
  { id: 'jumbo', file: './data/jumbo.json' },
  { id: 'plus',  file: './data/plus.json'  },
  { id: 'lidl',  file: './data/lidl.json'  },
];

const HISTORY_FILE = './data/price-history.json';
const MAX_DAYS     = 60;
const MAX_AGE_MS   = MAX_DAYS * 24 * 60 * 60 * 1000;
const now          = Date.now();
const today        = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Laad bestaande geschiedenis
let history = {};
if (existsSync(HISTORY_FILE)) {
  try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch {}
}

let changed = 0;

for (const store of STORES) {
  if (!existsSync(store.file)) { console.log(`Sla over: ${store.file} niet gevonden`); continue; }
  let data;
  try { data = JSON.parse(readFileSync(store.file, 'utf8')); } catch { continue; }
  const products = data.products || [];

  for (const p of products) {
    const price = typeof p.price === 'number' ? p.price : null;
    if (price === null) continue;

    const key = `${store.id}:${p.id || p.name}`;
    if (!history[key]) history[key] = { name: p.name, entries: [] };

    const entries = history[key].entries;

    // Verwijder oude entries (>60 dagen)
    history[key].entries = entries.filter(([ts]) => now - ts < MAX_AGE_MS);

    // Voeg alleen toe als prijs veranderd is of het de eerste entry van vandaag is
    const lastEntry = history[key].entries.at(-1);
    const lastDate  = lastEntry ? new Date(lastEntry[0]).toISOString().slice(0, 10) : null;
    if (!lastEntry || lastEntry[1] !== price || lastDate !== today) {
      history[key].entries.push([now, price]);
      changed++;
    }
  }
}

// Verwijder lege keys
for (const key of Object.keys(history)) {
  if (!history[key].entries.length) delete history[key];
}

writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8');
console.log(`Prijsgeschiedenis bijgewerkt: ${changed} prijzen opgeslagen, ${Object.keys(history).length} producten getrackt.`);

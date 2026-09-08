/**
 * Boodschappenheld – Prijsgeschiedenis bijhouden
 *
 * Leest de huidige winkeldata en voegt de prijzen toe aan
 * data/price-history.json. Bewaart maximaal 60 dagen.
 *
 * Dit bestand is een BUILD-ARTEFACT: de app haalt het niet meer op.
 * scripts/build-price-trends.mjs verdicht het tot de paar velden die de app
 * nodig heeft en schrijft die direct in de winkel-JSON.
 *
 * Formaat price-history.json:
 * {
 *   "ah:wi1234567": { name: "Halfvolle melk 1L", entries: [[timestamp, price, bonus_price|null], ...] },
 *   ...
 * }
 * bonus_price is null als er geen actieve aanbieding is.
 *
 * Een entry wordt ALLEEN toegevoegd als de prijs of bonusprijs verandert.
 * Een prijs geldt dus vanaf zijn timestamp tot aan de volgende entry (of nu).
 * Lezers moeten daarom tijdsgewogen rekenen, niet per entry tellen.
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

// Laad bestaande geschiedenis
let history = {};
if (existsSync(HISTORY_FILE)) {
  try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch {}
}

// ── Compactie ───────────────────────────────────────────────────────────────
// Eerdere versies schreven elke dag een entry, ook als de prijs gelijk bleef.
// Dat blies het bestand op tot tientallen MB's. Gooi opeenvolgende duplicaten
// weg; de eerste entry van een prijs is de enige die informatie draagt.
function compact(entries) {
  const out = [];
  let lastPrice = NaN, lastBonus;
  for (const e of entries) {
    const price = e[1];
    const bonus = e[2] ?? null;
    if (price !== lastPrice || bonus !== lastBonus) {
      out.push(bonus === null ? [e[0], price] : [e[0], price, bonus]);
      lastPrice = price;
      lastBonus = bonus;
    }
  }
  return out;
}

let entriesBefore = 0, entriesAfter = 0;
for (const key of Object.keys(history)) {
  const rec = history[key];
  if (!rec || !Array.isArray(rec.entries)) { delete history[key]; continue; }
  entriesBefore += rec.entries.length;
  rec.entries = compact(rec.entries.filter(([ts]) => now - ts < MAX_AGE_MS));
  entriesAfter += rec.entries.length;
}

// ── Nieuwe prijzen toevoegen ────────────────────────────────────────────────
let changed = 0;

for (const store of STORES) {
  if (!existsSync(store.file)) { console.log(`Sla over: ${store.file} niet gevonden`); continue; }
  let data;
  try { data = JSON.parse(readFileSync(store.file, 'utf8')); } catch { continue; }
  const products = data.products || [];

  for (const p of products) {
    const price = typeof p.price === 'number' ? p.price : null;
    if (price === null || !p.id) continue; // sla over zonder stabiel ID (voorkomen duplicaten bij herindexatie)

    const key = `${store.id}:${p.id}`;
    if (!history[key]) history[key] = { name: p.name, entries: [] };
    const rec = history[key];

    const bonusPrice = typeof p.bonus_price === 'number' ? p.bonus_price : null;
    const last = rec.entries.at(-1);

    // Alleen bij een echte wijziging. Een ongewijzigde prijs voegt niets toe:
    // de vorige entry geldt door tot de volgende.
    if (!last || last[1] !== price || (last[2] ?? null) !== bonusPrice) {
      rec.entries.push(bonusPrice === null ? [now, price] : [now, price, bonusPrice]);
      changed++;
    }
  }
}

// Verwijder lege keys
for (const key of Object.keys(history)) {
  if (!history[key].entries.length) delete history[key];
}

writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8');
console.log(
  `Prijsgeschiedenis: ${changed} nieuwe prijzen, ${Object.keys(history).length} producten getrackt. ` +
  `Entries ${entriesBefore} → ${entriesAfter + changed} (compactie).`
);

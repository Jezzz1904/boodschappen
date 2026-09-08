/**
 * Boodschappenheld – Prijstrends verdichten
 *
 * data/price-history.json is een build-artefact van tientallen MB's. De app
 * gebruikte er maar drie dingen uit: het prijsverschil t.o.v. een week
 * geleden, of dit de laagste prijs in 30 dagen is, en het 30-daags gemiddelde
 * (voor de hamster-tip). Dit script rekent die uit en schrijft ze als veld `t`
 * in de winkel-JSON, zodat de app de historie niet meer hoeft op te halen.
 *
 * Veld op een product (alleen aanwezig als er iets te melden valt):
 *   t.d  prijsverschil t.o.v. 7 dagen geleden (+ = duurder), 2 decimalen
 *   t.l  1 als de huidige prijs de laagste is in 30 dagen
 *   t.a  tijdsgewogen 30-daags gemiddelde, alleen als de huidige prijs
 *        minstens 10% daaronder ligt (input voor de hamster-tip)
 *
 * Prijsgeschiedenis is run-length: een entry geldt vanaf zijn timestamp tot
 * aan de volgende (of tot nu). Alles hieronder rekent daarom tijdsgewogen.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'node:url';

const STORES = [
  { id: 'ah',    file: './data/ah.json'    },
  { id: 'jumbo', file: './data/jumbo.json' },
  { id: 'plus',  file: './data/plus.json'  },
  { id: 'lidl',  file: './data/lidl.json'  },
];

const HISTORY_FILE = './data/price-history.json';
const DAY = 24 * 60 * 60 * 1000;

// Minimale dekking binnen het venster voordat we iets durven te beweren.
const MIN_COVER_LOWEST  = 3 * DAY;
const MIN_COVER_AVERAGE = 5 * DAY;
const HAMSTER_THRESHOLD = 0.10;

/**
 * Segmenteert de entries binnen [now-30d, now] naar [prijs, duur-in-ms].
 * Een entry vóór het venster telt mee als startprijs van het venster.
 */
export function segments(entries, now) {
  const month = now - 30 * DAY;
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const from = Math.max(entries[i][0], month);
    const to   = Math.min(i + 1 < entries.length ? entries[i + 1][0] : now, now);
    if (to > from) out.push([entries[i][1], to - from]);
  }
  return out;
}

export function priceAt(entries, ts) {
  let val = null;
  for (const [t, p] of entries) {
    if (t <= ts) val = p; else break;
  }
  return val ?? entries[0][1];
}

export function buildTrend(entries, current, now = Date.now()) {
  if (!entries?.length || typeof current !== 'number') return null;

  const segs  = segments(entries, now);
  const cover = segs.reduce((a, [, ms]) => a + ms, 0);
  const t = {};

  // Verschil t.o.v. een week geleden
  const old = priceAt(entries, now - 7 * DAY);
  if (typeof old === 'number' && old > 0) {
    const d = +(current - old).toFixed(2);
    if (d !== 0) t.d = d;
  }

  // Laagste in 30 dagen — alleen zinvol als de prijs in dat venster varieerde
  if (cover >= MIN_COVER_LOWEST) {
    const prices = segs.map(([p]) => p);
    const min = Math.min(...prices);
    if (Math.max(...prices) > min && current <= min) t.l = 1;
  }

  // Tijdsgewogen 30-daags gemiddelde, alleen als de hamster-tip kan afgaan
  if (cover >= MIN_COVER_AVERAGE) {
    const weighted = segs.reduce((a, [p, ms]) => a + p * ms, 0) / cover;
    if (weighted > 0 && (weighted - current) / weighted >= HAMSTER_THRESHOLD) {
      t.a = +weighted.toFixed(2);
    }
  }

  return Object.keys(t).length ? t : null;
}

export function main() {
  if (!existsSync(HISTORY_FILE)) {
    console.log('Geen prijsgeschiedenis gevonden — trends overgeslagen.');
    return;
  }
  const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  const now = Date.now();
  let totalProducts = 0, withTrend = 0;

  for (const store of STORES) {
    if (!existsSync(store.file)) { console.log(`Sla over: ${store.file} niet gevonden`); continue; }
    const data = JSON.parse(readFileSync(store.file, 'utf8'));
    const products = data.products || [];
    let n = 0;

    for (const p of products) {
      delete p.t; // altijd opnieuw opbouwen, nooit een oude trend laten staan
      totalProducts++;
      if (!p.id) continue;
      const rec = history[`${store.id}:${p.id}`];
      const t = buildTrend(rec?.entries, p.price, now);
      if (t) { p.t = t; n++; withTrend++; }
    }

    writeFileSync(store.file, JSON.stringify(data), 'utf8');
    console.log(`${store.id}: ${n}/${products.length} producten met trend.`);
  }

  const pct = totalProducts ? (withTrend / totalProducts * 100).toFixed(1) : '0.0';
  console.log(`Trends klaar: ${withTrend}/${totalProducts} producten (${pct}%).`);
}

// Alleen draaien als dit bestand direct wordt aangeroepen, niet bij import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

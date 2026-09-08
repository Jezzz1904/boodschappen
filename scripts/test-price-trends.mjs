// Test de trend-berekening van build-price-trends.mjs.
// Run: node scripts/test-price-trends.mjs

import { buildTrend } from './build-price-trends.mjs';
import { compact, prune } from './update-price-history.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8); // vast referentiepunt, geen echte klok
const ago = d => NOW - d * DAY;

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      verwacht: ${e}\n      gekregen: ${a}`); }
}

console.log('\nPrijstrends\n' + '─'.repeat(60));

// ── Weekverschil (t.d) ──
check('duurder dan vorige week',
  buildTrend([[ago(40), 1.00], [ago(3), 1.20]], 1.20, NOW)?.d, 0.2);

check('goedkoper dan vorige week',
  buildTrend([[ago(40), 2.00], [ago(2), 1.50]], 1.50, NOW)?.d, -0.5);

check('prijs onveranderd geeft geen trend',
  buildTrend([[ago(40), 1.00]], 1.00, NOW), null);

check('wijziging binnen de week telt vanaf de prijs van 7 dagen geleden',
  // 7 dagen geleden gold nog 1.00; de verhoging naar 1.50 was daarna
  buildTrend([[ago(20), 1.00], [ago(4), 1.50]], 1.50, NOW)?.d, 0.5);

check('wijziging vóór de week telt niet mee',
  // 7 dagen geleden gold 1.50 al, dus geen weekverschil
  buildTrend([[ago(20), 1.00], [ago(9), 1.50]], 1.50, NOW)?.d, undefined);

// ── Laagste in 30 dagen (t.l) ──
check('laagste in 30 dagen',
  buildTrend([[ago(25), 2.00], [ago(2), 1.20]], 1.20, NOW)?.l, 1);

check('niet de laagste',
  buildTrend([[ago(25), 1.00], [ago(2), 1.80]], 1.80, NOW)?.l, undefined);

check('vlakke prijs is geen 30-daagse low',
  // nooit hoger geweest, dus "laagste in 30 dagen" zegt niets
  buildTrend([[ago(50), 1.00]], 1.00, NOW)?.l, undefined);

check('prijspiek buiten het venster telt niet mee',
  // de 5.00 lag vóór de 30 dagen; binnen het venster is het altijd 1.00
  buildTrend([[ago(45), 5.00], [ago(35), 1.00]], 1.00, NOW)?.l, undefined);

check('te weinig dekking geeft geen low',
  buildTrend([[ago(2), 3.00], [ago(1), 1.00]], 1.00, NOW)?.l, undefined);

// ── Hamster-gemiddelde (t.a) ──
check('tijdsgewogen gemiddelde bij flinke korting',
  // 29 dagen op 2.00 + 1 dag op 1.00 → (29*2 + 1*1)/30 = 1.97
  buildTrend([[ago(30), 2.00], [ago(1), 1.00]], 1.00, NOW)?.a, 1.97);

check('gemiddelde is tijdsgewogen, niet per entry',
  // 27 dagen op 3.00 + 3 dagen op 1.00 → (27*3 + 3*1)/30 = 2.80
  buildTrend([[ago(30), 3.00], [ago(3), 1.00]], 1.00, NOW)?.a, 2.80);

check('kleine korting haalt de drempel niet',
  // 5% onder gemiddeld, drempel is 10%
  buildTrend([[ago(30), 1.00], [ago(1), 0.95]], 0.95, NOW)?.a, undefined);

check('te weinig dekking geeft geen gemiddelde',
  buildTrend([[ago(4), 3.00]], 1.00, NOW)?.a, undefined);

// ── Randgevallen ──
check('lege historie', buildTrend([], 1.00, NOW), null);
check('geen historie', buildTrend(undefined, 1.00, NOW), null);
check('prijs ontbreekt', buildTrend([[ago(10), 1.00]], null, NOW), null);

check('alle drie de velden tegelijk',
  buildTrend([[ago(30), 2.00], [ago(5), 2.00], [ago(1), 1.00]], 1.00, NOW),
  { d: -1, l: 1, a: 1.97 });

console.log('\nCompactie en snoeien\n' + '─'.repeat(60));

// ── compact(): opeenvolgende duplicaten weg ──
check('gelijke prijzen worden samengevouwen',
  compact([[1, 1.89], [2, 1.89], [3, 1.89]]), [[1, 1.89]]);

check('elke wijziging blijft staan',
  compact([[1, 1.00], [2, 1.50], [3, 1.50], [4, 1.00]]),
  [[1, 1.00], [2, 1.50], [4, 1.00]]);

check('bonusprijs telt mee als wijziging',
  compact([[1, 2.00, null], [2, 2.00, 1.50], [3, 2.00, 1.50]]),
  [[1, 2.00], [2, 2.00, 1.50]]);

check('null-bonus wordt weggelaten uit de entry',
  compact([[1, 2.00, null]]), [[1, 2.00]]);

// ── prune(): 60 dagen, maar de baseline blijft ──
check('recente entries blijven',
  prune([[ago(10), 1.00], [ago(2), 1.20]], NOW),
  [[ago(10), 1.00], [ago(2), 1.20]]);

check('de laatste entry vóór de grens blijft als baseline',
  // 90 dagen oud valt buiten het venster, maar bepaalt wél de prijs op de grens
  prune([[ago(90), 1.00], [ago(5), 1.20]], NOW),
  [[ago(90), 1.00], [ago(5), 1.20]]);

check('alleen de laatste van meerdere oude entries blijft',
  prune([[ago(100), 0.80], [ago(90), 1.00], [ago(5), 1.20]], NOW),
  [[ago(90), 1.00], [ago(5), 1.20]]);

check('een al lang stabiele prijs overleeft het snoeien',
  // dit was de bug: één entry van 61 dagen oud werd weggegooid, waarna de
  // prijs elke keer opnieuw "vandaag begonnen" leek en de trend verdween
  prune([[ago(61), 1.00]], NOW), [[ago(61), 1.00]]);

console.log('─'.repeat(60));
console.log(`${pass} geslaagd, ${fail} gefaald.`);
process.exit(fail ? 1 : 0);

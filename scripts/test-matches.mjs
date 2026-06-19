// Test alle VARIANTS-items tegen de echte winkeldata.
// Rapporteert welke items geen enkele prijs vinden.
// Run: node scripts/test-matches.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Extraheer JS-data uit index.html ──
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');

// Extract SYNONYMS, MATCH_STOPWORDS, UNIT_TOKENS, VARIANTS, BRAND_NOISE
function extractBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j === -1) return null;
  return src.slice(i, j + endMarker.length);
}

// Voer het script-blok uit in een beperkte context om de constanten te pakken
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('Geen script gevonden'); process.exit(1); }
const scriptCode = scriptMatch[1];

// Extract SYNONYMS array
const synBlock = scriptCode.match(/const SYNONYMS\s*=\s*\[([\s\S]*?)\];/);
let SYNONYMS = [];
if (synBlock) {
  // Evaluate the synonyms array
  try { SYNONYMS = eval('[' + synBlock[1] + ']'); } catch(e) { console.warn('Synonyms parse fout:', e.message); }
}

// Extract MATCH_STOPWORDS
const MATCH_STOPWORDS = new Set(['de','het','een','met','en','of','voor','van','in','op','bio','biologisch']);

// Extract UNIT_TOKENS
const unitBlock = scriptCode.match(/const UNIT_TOKENS\s*=\s*new Set\(\[(.*?)\]\)/);
let UNIT_TOKENS = new Set();
if (unitBlock) {
  try { UNIT_TOKENS = new Set(eval('[' + unitBlock[1] + ']')); } catch(e) {}
}

// ── Matching functies (gespiegeld uit index.html) ──
function applySynonyms(s) {
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  return s;
}

function normalize(s) { return (s || '').trim().toLowerCase(); }

function isQtyToken(w) {
  if (UNIT_TOKENS.has(w)) return true;
  if (/^\d+([.,]\d+)?$/.test(w)) return true;
  if (/^\d+([.,]\d+)?(l|ml|cl|dl|g|gr|kg|st|stuks?|x|pak)$/.test(w)) return true;
  return false;
}

function normWords(s, stripUnits = true) {
  const cleaned = applySynonyms(
    normalize(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  );
  let words = cleaned.split(/[\s,.;:()/\-+]+/).filter(w => w && !MATCH_STOPWORDS.has(w));
  if (stripUnits) words = words.filter(w => !isQtyToken(w));
  return words;
}

function wordMatches(itemWord, productWord) {
  if (productWord === itemWord) return true;
  if (productWord === itemWord + 's') return true;
  if (productWord === itemWord + 'en') return true;
  if (productWord === itemWord + 'es') return true;
  if (itemWord === productWord + 's' || itemWord === productWord + 'en') return true;
  return false;
}

function findMatch(itemName, products) {
  const itemWords = normWords(itemName);
  if (!itemWords.length) return null;

  for (const p of products) {
    const productWords = p._w;
    const allMatch = itemWords.every(iw => productWords.some(pw => wordMatches(iw, pw)));
    if (allMatch) return p;
  }
  return null;
}

// ── Laad winkeldata ──
const stores = ['ah', 'jumbo', 'lidl', 'plus'];
const storeData = {};
for (const id of stores) {
  try {
    const raw = await readFile(resolve(ROOT, `data/${id}.json`), 'utf8');
    const data = JSON.parse(raw);
    storeData[id] = data.products.map(p => ({ ...p, _w: normWords(p.name) }));
  } catch(e) {
    console.warn(`! ${id}.json niet gevonden: ${e.message}`);
    storeData[id] = [];
  }
}

// ── Extract VARIANTS uit de HTML ──
// We evalueren het VARIANTS object in een sandbox
const variantsBlocks = [];
const varRegex = /const VARIANTS\s*=\s*\{/g;
let vm;
// Vind het VARIANTS object — het is een groot object literal
const varStart = scriptCode.indexOf('const VARIANTS = {');
if (varStart === -1) { console.error('VARIANTS niet gevonden'); process.exit(1); }
// Zoek de bijbehorende sluitende };
let depth = 0, varEnd = -1;
for (let i = varStart + 'const VARIANTS = '.length; i < scriptCode.length; i++) {
  if (scriptCode[i] === '{') depth++;
  if (scriptCode[i] === '}') { depth--; if (depth === 0) { varEnd = i + 1; break; } }
}
const variantsCode = scriptCode.slice(varStart, varEnd);
let VARIANTS;
try {
  VARIANTS = eval('(' + variantsCode.replace('const VARIANTS = ', '') + ')');
} catch(e) {
  console.error('VARIANTS eval fout:', e.message);
  process.exit(1);
}

// ── Genereer alle testbare item-namen ──
function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const testItems = [];

for (const [key, val] of Object.entries(VARIANTS)) {
  if (!val || !val.groups) {
    // Simpele array-variant: elke waarde is een item
    if (Array.isArray(val)) {
      for (const v of val) testItems.push({ key, name: v, source: `${key} → ${v}` });
    }
    continue;
  }

  const groupNames = Object.keys(val.groups);
  const merkGroup = val.groups['Merk'];
  const nonMerkGroups = groupNames.filter(g => g !== 'Merk');

  // Test 1: baseTerm zonder variant (zonder soort)
  testItems.push({ key, name: titleCase(key), source: `${key} (zonder soort)` });

  // Test 2: elke non-Merk optie apart — simuleer slimme baseTerm logica
  for (const g of nonMerkGroups) {
    for (const opt of val.groups[g]) {
      const picksText = opt.toLowerCase();
      let name;
      if (picksText.includes(key.toLowerCase())) {
        // Optie bevat al de baseTerm
        name = opt;
      } else {
        // Check of optie alleen al producten matcht (zoals in quickAddComposed)
        const testWords = normWords(opt);
        let anyMatch = false;
        if (testWords.length) {
          for (const products of Object.values(storeData)) {
            for (const p of products) {
              if (testWords.every(iw => p._w.some(pw => wordMatches(iw, pw)))) { anyMatch = true; break; }
            }
            if (anyMatch) break;
          }
        }
        name = anyMatch ? opt : `${titleCase(key)} ${opt}`;
      }
      testItems.push({ key, name, source: `${key} → ${g}: ${opt}` });
    }
  }
}

// ── Test elke item-naam tegen alle winkels ──
const noMatch = [];
const partialMatch = [];
let okCount = 0;

for (const item of testItems) {
  const matches = {};
  let total = 0;
  for (const [id, products] of Object.entries(storeData)) {
    const m = findMatch(item.name, products);
    if (m) { matches[id] = m.name; total++; }
  }
  if (total === 0) {
    noMatch.push(item);
  } else if (total < stores.length) {
    partialMatch.push({ ...item, matches, count: total });
    okCount++;
  } else {
    okCount++;
  }
}

// ── Rapport ──
console.log(`\n${'═'.repeat(60)}`);
console.log(`VARIANT-MATCH TEST — ${testItems.length} items getest`);
console.log(`${'═'.repeat(60)}`);
console.log(`✓ ${okCount} items gevonden (≥1 winkel)`);
console.log(`✗ ${noMatch.length} items NIET gevonden (0 winkels)\n`);

if (noMatch.length) {
  console.log(`${'─'.repeat(60)}`);
  console.log('GEEN MATCH (0 winkels):');
  console.log(`${'─'.repeat(60)}`);
  for (const item of noMatch) {
    console.log(`  ✗ "${item.name}"  ← ${item.source}`);
  }
}

if (partialMatch.length) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`GEDEELTELIJK (niet alle winkels):`);
  console.log(`${'─'.repeat(60)}`);
  // Alleen tonen als ≤2 winkels
  const weak = partialMatch.filter(p => p.count <= 2);
  for (const item of weak) {
    const found = Object.entries(item.matches).map(([id, name]) => `${id}: "${name}"`).join(', ');
    console.log(`  △ "${item.name}" (${item.count}/${stores.length})  ← ${item.source}`);
    console.log(`    gevonden bij: ${found}`);
  }
  if (weak.length < partialMatch.length) {
    console.log(`  ... en ${partialMatch.length - weak.length} items bij 3/${stores.length} winkels (prima)`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Klaar. ${noMatch.length === 0 ? '🎉 Alles matcht!' : `⚠️  ${noMatch.length} items zonder prijs.`}`);

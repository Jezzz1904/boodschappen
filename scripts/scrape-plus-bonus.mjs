// Plus weekaanbiedingen scraper via Playwright (headless Chromium).
// Navigeert naar plus.nl/aanbiedingen, pakt deal + naam + datum,
// schrijft bonus-velden terug in data/plus.json.
//
// Lokaal: npx playwright install chromium && node scripts/scrape-plus-bonus.mjs
// CI: zie .github/workflows/scrape.yml

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUS_OUT = resolve(ROOT, 'data/plus.json');
const DELAY    = ms => new Promise(r => setTimeout(r, ms));

const OFFERS_URL = 'https://www.plus.nl/aanbiedingen';

const MONTHS = { jan:1,feb:2,mrt:3,apr:4,mei:5,jun:6,jul:7,aug:8,sep:9,okt:10,nov:11,dec:12 };
function parseDateRange(text) {
  if (!text) return { from: null, to: null };
  const m = text.match(/(\d{1,2})\s*(?:(\w{3})\s*)?t\/m\s*(\d{1,2})\s+(\w{3})/i);
  if (!m) return { from: null, to: null };
  const year = new Date().getFullYear();
  const toMonth   = MONTHS[m[4].toLowerCase()] || null;
  const fromMonth = m[2] ? (MONTHS[m[2].toLowerCase()] || toMonth) : toMonth;
  if (!toMonth) return { from: null, to: null };
  const pad = n => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(fromMonth)}-${pad(Number(m[1]))}`,
    to:   `${year}-${pad(toMonth)}-${pad(Number(m[3]))}`,
  };
}

function parseDeal(deal, regularPrice) {
  if (!deal) return { mechanism: null, bonusPrice: null };
  const t = deal.trim().toLowerCase();

  let m = t.match(/^(\d+)\s*(?:voor|x)\s*([\d,]+)$/);
  if (m) {
    const count = parseInt(m[1]);
    const total = parseFloat(m[2].replace(',', '.'));
    return { mechanism: deal, bonusPrice: +(total / count).toFixed(2) };
  }
  m = t.match(/^(\d+)\+(\d+)\s*gratis/);
  if (m) {
    const pay = parseInt(m[1]), free = parseInt(m[2]);
    if (regularPrice) return { mechanism: deal, bonusPrice: +(regularPrice * pay / (pay + free)).toFixed(2) };
    return { mechanism: deal, bonusPrice: null };
  }
  m = t.match(/^(\d+)e halve prijs/);
  if (m) {
    const n = parseInt(m[1]);
    if (regularPrice) return { mechanism: deal, bonusPrice: +(regularPrice * ((n - 1) + 0.5) / n).toFixed(2) };
    return { mechanism: deal, bonusPrice: null };
  }
  m = t.match(/^(\d+)%\s*korting/);
  if (m) {
    const pct = parseInt(m[1]);
    if (regularPrice) return { mechanism: deal, bonusPrice: +(regularPrice * (1 - pct / 100)).toFixed(2) };
    return { mechanism: deal, bonusPrice: null };
  }
  m = t.match(/^(?:nu\s*)?(?:voor\s*)?([\d,]+)$/);
  if (m) return { mechanism: deal, bonusPrice: parseFloat(m[1].replace(',', '.')) };

  return { mechanism: deal, bonusPrice: null };
}

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function words(s) { return norm(s).split(' ').filter(w => w.length > 2); }
function nameOverlap(a, b) {
  const wa = new Set(words(a));
  const wb = words(b);
  let hits = 0;
  for (const w of wb) if (wa.has(w)) hits++;
  return hits >= 2 || (wb.length === 1 && wa.has(wb[0]) && wb[0].length > 4);
}

async function scrapeOffers(page) {
  await page.goto(OFFERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Cookie-consent wegklikken
  for (const sel of [
    'button[id*="accept"]', '#onetrust-accept-btn-handler',
    '[data-testid="accept-all"]', 'button[class*="accept"]',
  ]) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); await DELAY(800); break; } } catch {}
  }

  // Scroll voor lazy-load
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await DELAY(400);
  }
  await DELAY(800);

  return page.evaluate(() => {
    // Plus.nl gebruikt verschillende card-structuren per periode
    // Probeer meerdere selectors
    const selectors = [
      '.promotion-card', '.product-card--promotion', '[class*="promotion"]',
      '.folder-item', '[data-testid*="promotion"]', '.offer-card',
      '[class*="offer-card"]', '[class*="deal-card"]',
    ];

    let cards = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 3) { cards = Array.from(found); break; }
    }

    // Fallback: zoek naar elementen met prijs-patroon in combinatie met een deal-label
    if (!cards.length) {
      cards = Array.from(document.querySelectorAll('[class*="card"]')).filter(c =>
        c.innerText && /\d+[,\.]\d{2}/.test(c.innerText) &&
        /(gratis|korting|voor|halve|%)/i.test(c.innerText)
      );
    }

    return cards.map(c => {
      const text = c.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // Naam: langste zin die geen prijs of deal-tekst is
      const nameEl = c.querySelector('h2,h3,[class*="title"],[class*="name"],[class*="product-name"]');
      const name = nameEl?.innerText?.trim() || lines.find(l =>
        l.length > 3 && !/^[\d,\.€%+x]/.test(l) && !/^(gratis|korting|aanbieding)/i.test(l)
      ) || null;

      // Deal-tekst
      const dealEl = c.querySelector('[class*="promo"],[class*="label"],[class*="tag"],[class*="deal"],[class*="sticker"],[class*="badge"]');
      const dealText = dealEl?.innerText?.trim() || lines.find(l =>
        /(gratis|\d+[,\.]\d{2}|%\s*korting|\+\d|\d+\s*voor|\d+e halve)/i.test(l)
      ) || null;

      // Datum
      const dateText = lines.find(l => /t\/m/i.test(l)) || null;

      // Prijs (regulier)
      const priceMatch = text.match(/(?:was\s*)?€?\s*(\d+[,\.]\d{2})/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;

      return { name, dealText, dateText, regularPrice: price };
    }).filter(c => c.name && c.dealText);
  });
}

async function main() {
  console.log('Plus bonus scraper (Playwright/Chromium)');

  let plusData;
  try {
    plusData = JSON.parse(await readFile(PLUS_OUT, 'utf8'));
  } catch {
    console.error('data/plus.json niet gevonden — draai eerst scrape-checkjebon.mjs plus');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'nl-NL',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  let offers = [];
  try {
    offers = await scrapeOffers(page);
    console.log(`  Gevonden: ${offers.length} aanbiedingen`);
  } finally {
    await browser.close();
  }

  if (!offers.length) {
    console.warn('Geen aanbiedingen gevonden — plus.json ongewijzigd.');
    return;
  }

  const baseProducts = (plusData.products || []).filter(p => !p.plus_bonus);

  let matchCount = 0;
  for (const offer of offers) {
    const { from, to } = parseDateRange(offer.dateText);
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name)) {
        const { mechanism, bonusPrice } = parseDeal(offer.dealText, p.price ?? offer.regularPrice);
        p.bonus_price = bonusPrice;
        p.bonus = { mechanism, start: from, end: to, infinite: false, conditional: false };
        matchCount++;
        console.log(`  ✓ Match: "${offer.name}" [${offer.dealText}] → "${p.name}" (€${bonusPrice ?? '?'})`);
        break;
      }
    }
  }

  const bonusProducts = offers.map(offer => {
    const { from, to } = parseDateRange(offer.dateText);
    const { mechanism, bonusPrice } = parseDeal(offer.dealText, offer.regularPrice);
    return {
      id: `plus_bonus_${norm(offer.name).replace(/ /g, '_')}`,
      name: offer.name,
      price: offer.regularPrice,
      bonus_price: bonusPrice,
      category: null,
      plus_bonus: true,
      bonus: { mechanism, start: from, end: to, infinite: false, conditional: false },
    };
  });

  plusData.products = [...baseProducts, ...bonusProducts];
  plusData.bonus_scraped_at = new Date().toISOString();
  plusData.bonus_count = bonusProducts.length;

  await writeFile(PLUS_OUT, JSON.stringify(plusData, null, 0), 'utf8');
  console.log(`\n✓ plus.json bijgewerkt: ${bonusProducts.length} bonus-producten, ${matchCount} matches`);
}

main().catch(err => { console.error('FOUT:', err.message); process.exit(1); });

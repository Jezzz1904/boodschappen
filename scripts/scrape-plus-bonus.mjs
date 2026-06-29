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
  const cleaned = text.replace(/\b(?:ma|di|wo|do|vr|za|zo)\b/gi, '').trim();
  const m = cleaned.match(/(\d{1,2})\s*(?:(\w{3})\s*)?t\/m\s*(\d{1,2})\s+(\w{3})/i);
  if (!m) {
    const m2 = cleaned.match(/t\/m\s*(\d{1,2})\s+(\w{3})/i);
    if (m2) {
      const year = new Date().getFullYear();
      const month = MONTHS[m2[2].toLowerCase()];
      if (!month) return { from: null, to: null };
      const pad = n => String(n).padStart(2, '0');
      return { from: new Date().toISOString().slice(0, 10), to: `${year}-${pad(month)}-${pad(Number(m2[1]))}` };
    }
    return { from: null, to: null };
  }
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
  m = t.match(/^(\d+)\s*%\s*korting/);
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
  await page.goto(OFFERS_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Cookie-consent wegklikken
  for (const sel of [
    'button[id*="accept"]', '#onetrust-accept-btn-handler',
    '[data-testid="accept-all"]', 'button[class*="accept"]',
  ]) {
    try { const btn = await page.$(sel); if (btn) { await btn.click(); await DELAY(800); break; } } catch {}
  }

  // Scroll voor lazy-load
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await DELAY(400);
  }
  await DELAY(1000);

  // Globale datum van de pagina ("Woensdag 17 juni t/m dinsdag 23 juni")
  const globalDate = await page.evaluate(() => {
    const el = document.querySelector('.promo-period-display');
    return el?.innerText?.trim() || null;
  });

  return page.evaluate(() => {
    const items = document.querySelectorAll('.plp-item-wrapper__promo');
    return Array.from(items).map(el => {
      const text = el.innerText?.trim() || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return null;

      // Skip "GRATIS BEZORGING" kaarten
      if (/gratis bezorging/i.test(lines[0])) return null;
      // Skip "Extra scherp geprijsd" headers
      if (/extra scherp/i.test(lines[0]) || /bekijk hier/i.test(lines[0])) return null;
      // Skip "poulepakkers" en andere promotie-banners
      if (/poulepakker|banner|inspiratie/i.test(text)) return null;

      // Promo-badge element
      const promoEl = el.querySelector('[class*="promo-label"], [class*="badge"], [class*="sticker"]');
      const promoBadge = promoEl?.innerText?.trim().replace(/\r/g, ' ') || null;

      // Detect deal pattern in lines
      const dealPatterns = /^\d+\s*(?:voor|x)\s*[\d,]+$|^\d+\+\d+\s*gratis|^\d+\s*%\s*korting|^\d+e halve prijs|^op=op$/i;

      let dealText = null;
      let nameStartIdx = 0;

      if (promoBadge && dealPatterns.test(promoBadge.replace(/\r?\n/g, ' '))) {
        dealText = promoBadge.replace(/\r?\n/g, ' ');
        // Name is the next non-deal line
        nameStartIdx = lines.findIndex(l => !dealPatterns.test(l) && l !== promoBadge.split('\n')[0]?.trim());
      } else {
        // Check first line for deal
        const firstClean = lines[0].replace(/\r/g, ' ');
        if (dealPatterns.test(firstClean)) {
          dealText = firstClean;
          nameStartIdx = 1;
        } else {
          // No explicit deal — this is a price-reduced item (just lower price shown)
          dealText = 'Aanbieding';
          nameStartIdx = 0;
        }
      }

      // Product name: first non-deal, non-date, non-price line
      let name = null;
      for (let i = nameStartIdx; i < lines.length; i++) {
        const l = lines[i];
        if (/t\/m/i.test(l)) continue;
        if (/^[\d.,]+$/.test(l)) continue;
        if (/^\d+\s*%/.test(l)) continue;
        if (/^per\s/i.test(l)) continue;
        if (/^bijv\./i.test(l)) continue;
        if (l.length < 3) continue;
        name = l;
        break;
      }

      // Date
      const dateLine = lines.find(l => /t\/m/i.test(l));

      // Prices: look for split price pattern "2.\n50" = 2.50 and old price
      let salePrice = null, regularPrice = null;
      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(/^(\d+)\.$/);
        if (m && /^\d{2}$/.test(lines[i + 1])) {
          const price = parseFloat(`${m[1]}.${lines[i + 1]}`);
          if (!salePrice) salePrice = price;
          else if (!regularPrice) regularPrice = price;
        }
      }
      // Single-line old price (e.g. "4.99")
      if (!regularPrice) {
        for (const l of lines) {
          const m2 = l.match(/^(\d+\.\d{2})$/);
          if (m2) {
            const p = parseFloat(m2[1]);
            if (salePrice && p > salePrice) { regularPrice = p; break; }
          }
        }
      }

      if (!name) return null;

      return {
        name,
        dealText,
        dateText: dateLine || null,
        salePrice,
        regularPrice,
      };
    }).filter(Boolean);
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
  let globalDate = null;
  try {
    offers = await scrapeOffers(page);
    // Get global date from page header
    globalDate = await page.evaluate(() => {
      const el = document.querySelector('.promo-period-display');
      return el?.innerText?.trim() || null;
    });
    console.log(`  Gevonden: ${offers.length} aanbiedingen`);
    if (globalDate) console.log(`  Periode: ${globalDate}`);
  } finally {
    await browser.close();
  }

  if (!offers.length) {
    console.warn('Geen aanbiedingen gevonden — plus.json ongewijzigd.');
    return;
  }
  if (offers.length < 5) {
    console.warn(`⚠️ Slechts ${offers.length} aanbieding(en) gevonden — Plus heeft mogelijk hun HTML gewijzigd.`);
  }

  const baseProducts = (plusData.products || []).filter(p => !p.plus_bonus);

  // Categorie-overerving van base-producten
  const catLookup = {};
  for (const offer of offers) {
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name) && p.cat) { catLookup[offer.name] = p.cat; break; }
    }
  }

  // Globale datum als fallback
  const globalDates = parseDateRange(globalDate);

  let matchCount = 0;
  for (const offer of offers) {
    const { from, to } = offer.dateText ? parseDateRange(offer.dateText) : globalDates;
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name)) {
        const price = p.price ?? offer.regularPrice;
        const { mechanism, bonusPrice } = parseDeal(offer.dealText, price);
        const effectiveBonus = bonusPrice ?? offer.salePrice;
        p.bonus_price = effectiveBonus;
        p.bonus = { mechanism, start: from, end: to, infinite: false, conditional: false };
        matchCount++;
        console.log(`  ✓ Match: "${offer.name}" [${offer.dealText}] → "${p.name}" (€${effectiveBonus ?? '?'})`);
        break;
      }
    }
  }

  const bonusProducts = offers.map(offer => {
    const { from, to } = offer.dateText ? parseDateRange(offer.dateText) : globalDates;
    const { mechanism, bonusPrice } = parseDeal(offer.dealText, offer.regularPrice);
    return {
      id: `plus_bonus_${norm(offer.name).replace(/ /g, '_')}`,
      name: offer.name,
      price: offer.regularPrice,
      bonus_price: bonusPrice ?? offer.salePrice,
      cat: catLookup[offer.name] || null,
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

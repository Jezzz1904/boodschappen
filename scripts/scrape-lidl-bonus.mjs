// Lidl weekaanbiedingen scraper via Playwright (headless Chromium).
// Navigeert naar lidl.nl/c/aanbiedingen, pakt product + prijs + bonus,
// en schrijft de data terug in data/lidl.json (bonus-velden bijwerken).
//
// Lokaal: npx playwright install chromium && node scripts/scrape-lidl-bonus.mjs
// CI: zie .github/workflows/scrape.yml (Playwright + Chromium al geïnstalleerd)

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIDL_OUT = resolve(ROOT, 'data/lidl.json');
const DELAY    = ms => new Promise(r => setTimeout(r, ms));

const OFFERS_URL = 'https://www.lidl.nl/c/aanbiedingen/a10008785';

// dd/mm → yyyy-mm-dd (jaar afleiden uit context)
function toIso(ddmm, year = new Date().getFullYear()) {
  const [d, m] = ddmm.split('/');
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Simpele normalisatie voor naam-matching (spiegelt normWords in de PWA)
function norm(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s) { return norm(s).split(' ').filter(w => w.length > 2); }

// Geeft true als ≥2 woorden overlappen (of het langste woord)
function nameOverlap(a, b) {
  const wa = new Set(words(a));
  const wb = words(b);
  let hits = 0;
  for (const w of wb) if (wa.has(w)) hits++;
  return hits >= 2 || (wb.length === 1 && wa.has(wb[0]) && wb[0].length > 4);
}

async function scrapeOffers(page) {
  await page.waitForSelector('.product-grid-box', { timeout: 20000 });

  // Scroll langzaam naar beneden voor lazy-load
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await DELAY(400);
  }
  await DELAY(600);

  return page.evaluate(() => {
    const cards = document.querySelectorAll('.product-grid-box');
    return Array.from(cards).map(c => {
      const nameEl   = c.querySelector('.odsc-tile__link');
      const url      = nameEl?.getAttribute('href') || '';
      const idMatch  = url.match(/p(\d+)$/);

      const strokeEl   = c.querySelector('.ods-price__stroke-price');
      const valueEl    = c.querySelector('.ods-price__value');
      const discountEl = c.querySelector('.ods-price__box-content-text-el');
      const footerEl   = c.querySelector('.ods-price__footer');
      const isPlus     = !!c.querySelector('.ods-price__lidl-plus-hint');

      // Unit: alleen directe tekstknopen (skip tooltip-span)
      let unit = '';
      if (footerEl) {
        for (const n of footerEl.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) unit += n.textContent;
        }
        unit = unit.trim() || (footerEl.textContent || '').split('\n')[0].trim();
      }

      const strokeTxt  = strokeEl?.textContent?.trim() || null;
      const valueTxt   = valueEl?.textContent?.trim()  || null;
      const discoTxt   = discountEl?.textContent?.trim() || null;

      const allText    = c.innerText || '';
      const dateMatch  = allText.match(/(\d{2}\/\d{2})\s*-\s*(\d{2}\/\d{2})/);

      return {
        lidlId:       idMatch ? `p${idMatch[1]}` : null,
        name:         nameEl?.textContent?.trim() || null,
        unit:         unit || null,
        regularPrice: strokeTxt
          ? parseFloat(strokeTxt.replace(',', '.'))
          : (valueTxt ? parseFloat(valueTxt.replace(',', '.')) : null),
        salePrice: strokeTxt
          ? (valueTxt ? parseFloat(valueTxt.replace(',', '.')) : null)
          : null,
        isLidlPlus: isPlus,
        mechanism:  discoTxt && !/^Elders|Mega/.test(discoTxt) ? discoTxt : (isPlus ? 'Lidl Plus' : null),
        dateFrom:   dateMatch?.[1] || null,
        dateTo:     dateMatch?.[2] || null,
      };
    }).filter(p => p.lidlId && p.name);
  });
}

async function main() {
  console.log('Lidl bonus scraper (Playwright/Chromium)');

  // Lees huidige lidl.json (geschreven door scrape-checkjebon.mjs)
  let lidlData;
  try {
    lidlData = JSON.parse(await readFile(LIDL_OUT, 'utf8'));
  } catch {
    console.error('data/lidl.json niet gevonden — draai eerst scrape-checkjebon.mjs lidl');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:   'nl-NL',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  let offers = [];
  try {
    await page.goto(OFFERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Cookie-consent wegklikken als aanwezig
    for (const sel of ['#onetrust-accept-btn-handler', 'button[id*="accept-all"]', '[data-testid="accept-all-button"]']) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await DELAY(800); break; }
      } catch {}
    }

    offers = await scrapeOffers(page);
    console.log(`  Gevonden: ${offers.length} aanbiedingen`);
  } finally {
    await browser.close();
  }

  if (!offers.length) {
    console.warn('Geen aanbiedingen gevonden — lidl.json ongewijzigd.');
    return;
  }

  // Voeg bonus-Lidl-producten toe als extra producten met bonus-info
  // Verwijder eerst eventueel vorige bonus-entries (gemarkeerd met lidl_bonus: true)
  const baseProducts = (lidlData.products || []).filter(p => !p.lidl_bonus);

  const year = new Date().getFullYear();
  const bonusProducts = offers.map(o => ({
    id:          o.lidlId,
    name:        o.name,
    unit:        o.unit,
    price:       o.regularPrice,
    bonus_price: o.salePrice,
    category:    null,
    lidl_bonus:  true,   // marker zodat we ze volgende run kunnen vervangen
    bonus: (o.salePrice !== null || o.isLidlPlus) ? {
      mechanism:   o.mechanism,
      start:       o.dateFrom ? toIso(o.dateFrom, year) : null,
      end:         o.dateTo   ? toIso(o.dateTo,   year) : null,
      infinite:    false,
      conditional: o.isLidlPlus,
    } : null,
  }));

  // Bijwerken: als een naam in checkjebon-producten overeenkomt, bonus_price + bonus updaten
  let matchCount = 0;
  for (const offer of offers) {
    if (offer.salePrice === null && !offer.isLidlPlus) continue;
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name)) {
        p.bonus_price = offer.salePrice ?? null;
        p.bonus = {
          mechanism:   offer.mechanism,
          start:       offer.dateFrom ? toIso(offer.dateFrom, year) : null,
          end:         offer.dateTo   ? toIso(offer.dateTo,   year) : null,
          infinite:    false,
          conditional: offer.isLidlPlus,
        };
        matchCount++;
        console.log(`  ✓ Match: "${offer.name}" → "${p.name}" (€${offer.salePrice ?? offer.regularPrice})`);
        break;
      }
    }
  }

  lidlData.products = [...baseProducts, ...bonusProducts];
  lidlData.bonus_scraped_at = new Date().toISOString();
  lidlData.bonus_count = bonusProducts.length;

  await writeFile(LIDL_OUT, JSON.stringify(lidlData, null, 0), 'utf8');
  console.log(`\n✓ lidl.json bijgewerkt: ${bonusProducts.length} bonus-producten toegevoegd, ${matchCount} checkjebon-matches bijgewerkt`);
}

main().catch(err => {
  console.error('FOUT:', err.message);
  process.exit(1);
});

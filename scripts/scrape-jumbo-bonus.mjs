// Jumbo weekaanbiedingen scraper via Playwright (headless Chromium).
// Navigeert naar jumbo.com/aanbiedingen/nu, pakt deal-tekst + productnaam + datum,
// en schrijft bonus-velden terug in data/jumbo.json.
//
// Lokaal: npx playwright install chromium && node scripts/scrape-jumbo-bonus.mjs
// CI: zie .github/workflows/scrape.yml

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT      = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JUMBO_OUT = resolve(ROOT, 'data/jumbo.json');
const DELAY     = ms => new Promise(r => setTimeout(r, ms));

const OFFERS_URL = 'https://www.jumbo.com/aanbiedingen/nu';

// "wo 17 t/m di 23 jun" of "t/m di 23 jun" → { from: "yyyy-mm-dd", to: "yyyy-mm-dd" }
const MONTHS = { jan:1,feb:2,mrt:3,apr:4,mei:5,jun:6,jul:7,aug:8,sep:9,okt:10,nov:11,dec:12 };
function parseDateRange(text) {
  if (!text) return { from: null, to: null };
  // Strip dagnamen (ma/di/wo/do/vr/za/zo)
  const cleaned = text.replace(/\b(?:ma|di|wo|do|vr|za|zo)\b/gi, '').trim();
  const m = cleaned.match(/(\d{1,2})\s*(?:(\w{3})\s*)?t\/m\s*(\d{1,2})\s+(\w{3})/i);
  if (!m) {
    // Fallback: "t/m 23 jun" (alleen einddatum)
    const m2 = cleaned.match(/t\/m\s*(\d{1,2})\s+(\w{3})/i);
    if (m2) {
      const year = new Date().getFullYear();
      const month = MONTHS[m2[2].toLowerCase()];
      if (!month) return { from: null, to: null };
      const pad = n => String(n).padStart(2, '0');
      const today = new Date().toISOString().slice(0, 10);
      return { from: today, to: `${year}-${pad(month)}-${pad(Number(m2[1]))}` };
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

// Deal-tekst → { mechanism, bonusPrice } (bonusPrice = effectieve prijs per stuk of null)
// Voorbeelden: "2 voor 3,99" "1+1 gratis" "25% korting" "2e halve prijs" "voor 4,99"
function parseDeal(deal, regularPrice) {
  if (!deal) return { mechanism: null, bonusPrice: null };
  const t = deal.trim().toLowerCase();

  // "2 voor 3,99" / "3 voor 5,00"
  let m = t.match(/^(\d+)\s*voor\s*([\d,]+)$/);
  if (m) {
    const count = parseInt(m[1]);
    const total = parseFloat(m[2].replace(',', '.'));
    return { mechanism: deal, bonusPrice: +(total / count).toFixed(2) };
  }

  // "1+1 gratis" / "2+1 gratis"
  m = t.match(/^(\d+)\+(\d+)\s*gratis/);
  if (m) {
    const pay = parseInt(m[1]), free = parseInt(m[2]);
    if (regularPrice) {
      return { mechanism: deal, bonusPrice: +(regularPrice * pay / (pay + free)).toFixed(2) };
    }
    return { mechanism: deal, bonusPrice: null };
  }

  // "2e halve prijs" / "3e halve prijs"
  m = t.match(/^(\d+)e halve prijs/);
  if (m) {
    const n = parseInt(m[1]);
    if (regularPrice) {
      const paid = (n - 1) + 0.5;
      return { mechanism: deal, bonusPrice: +(regularPrice * paid / n).toFixed(2) };
    }
    return { mechanism: deal, bonusPrice: null };
  }

  // "25% korting" / "30% korting"
  m = t.match(/^(\d+)%\s*korting/);
  if (m) {
    const pct = parseInt(m[1]);
    if (regularPrice) {
      return { mechanism: deal, bonusPrice: +(regularPrice * (1 - pct / 100)).toFixed(2) };
    }
    return { mechanism: deal, bonusPrice: null };
  }

  // "voor 4,99" (vaste bonusprijs)
  m = t.match(/^voor\s*([\d,]+)$/);
  if (m) {
    return { mechanism: deal, bonusPrice: parseFloat(m[1].replace(',', '.')) };
  }

  return { mechanism: deal, bonusPrice: null };
}

// Normaliseer voor naam-matching
function norm(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    'button[data-testid="accept-cookies"]',
    '#onetrust-accept-btn-handler',
    'button[id*="accept"]',
    '[aria-label*="Accept"]',
    '[aria-label*="akkoord"]',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await DELAY(800); break; }
    } catch {}
  }

  // Scroll om lazy-load te triggeren
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await DELAY(400);
  }
  await DELAY(1000);

  return page.evaluate(() => {
    const cards = document.querySelectorAll('.card-promotion');
    return Array.from(cards).map(c => {
      const tagEl      = c.querySelector('.jum-tag');
      const titleEl    = c.querySelector('.title');
      const subtitleEl = c.querySelector('.subtitle');
      const id         = c.id || null;

      const rawTag  = tagEl?.innerText?.trim() || '';
      const name    = titleEl?.innerText?.trim() || null;
      const dateText = subtitleEl?.innerText?.trim() || null;

      // Tag kan "Alleen in de winkel\nvoor 1,99" bevatten — strip "Alleen in de winkel" prefix
      const inStoreOnly = /alleen in de winkel/i.test(rawTag);
      const dealText = rawTag.replace(/^alleen in de winkel\s*/i, '').trim() || null;

      return { id, dealText, name, dateText, inStoreOnly };
    }).filter(c => c.name && c.dealText);
  });
}

async function main() {
  console.log('Jumbo bonus scraper (Playwright/Chromium)');

  let jumboData;
  try {
    jumboData = JSON.parse(await readFile(JUMBO_OUT, 'utf8'));
  } catch {
    console.error('data/jumbo.json niet gevonden — draai eerst scrape-checkjebon.mjs jumbo');
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
    console.warn('Geen aanbiedingen gevonden — jumbo.json ongewijzigd.');
    return;
  }

  const baseProducts = (jumboData.products || []).filter(p => !p.jumbo_bonus);

  // Bijwerken bestaande producten op naam-match
  let matchCount = 0;
  for (const offer of offers) {
    const { from, to } = parseDateRange(offer.dateText);
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name)) {
        const { mechanism, bonusPrice } = parseDeal(offer.dealText, p.price);
        p.bonus_price = bonusPrice;
        p.bonus = {
          mechanism,
          start:       from,
          end:         to,
          infinite:    false,
          conditional: false,
        };
        matchCount++;
        console.log(`  ✓ Match: "${offer.name}" [${offer.dealText}] → "${p.name}" (bonus_price: €${bonusPrice ?? '?'})`);
        break;
      }
    }
  }

  // Categorie-overerving van base-producten
  const catLookup = {};
  for (const offer of offers) {
    for (const p of baseProducts) {
      if (nameOverlap(p.name, offer.name) && p.cat) { catLookup[offer.name] = p.cat; break; }
    }
  }

  // Voeg nieuwe bonus-entries toe
  const bonusProducts = offers.map(offer => {
    const { from, to } = parseDateRange(offer.dateText);
    const { mechanism, bonusPrice } = parseDeal(offer.dealText, null);
    return {
      id:          offer.id || `jumbo_bonus_${norm(offer.name).replace(/ /g, '_')}`,
      name:        offer.name,
      price:       null,
      bonus_price: bonusPrice,
      cat:         catLookup[offer.name] || null,
      jumbo_bonus: true,
      bonus: {
        mechanism,
        start:       from,
        end:         to,
        infinite:    false,
        conditional: false,
      },
    };
  });

  jumboData.products = [...baseProducts, ...bonusProducts];
  jumboData.bonus_scraped_at = new Date().toISOString();
  jumboData.bonus_count = bonusProducts.length;

  await writeFile(JUMBO_OUT, JSON.stringify(jumboData, null, 0), 'utf8');
  console.log(`\n✓ jumbo.json bijgewerkt: ${bonusProducts.length} bonus-producten toegevoegd, ${matchCount} checkjebon-matches bijgewerkt`);
}

main().catch(err => {
  console.error('FOUT:', err.message);
  process.exit(1);
});

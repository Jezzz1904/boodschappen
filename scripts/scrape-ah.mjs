// AH scraper — gebruikt de officiele mobile-app API met anoniem token.
// Geen browser nodig. Output: data/ah.json
// Run lokaal: node scripts/scrape-ah.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/ah.json');

const UA = 'Appie/8.22.3';
const APP = 'AHWEBSHOP';
const PAGE_SIZE = 30;
const DELAY_MS = 200;
const MAX_RETRIES = 2;

// Brede dekking — staples + boodschappenlijst-thema's. Dedup gebeurt op productId.
const SEARCH_TERMS = [
  // Zuivel
  'melk','halfvolle melk','volle melk','karnemelk','yoghurt','kwark','vla','slagroom','room','boter','margarine',
  'kaas','jong belegen','belegen','geraspte kaas','smeerkaas','mozzarella','feta','ei','eieren','pudding',
  'plantaardig drink','havermelk','sojadrink',
  // Bakkerij
  'brood','bruin brood','wit brood','volkoren','stokbrood','tijgerbrood','croissant','beschuit','crackers',
  'wraps','pita','rozijnenbol','krentenbol',
  // Groente fruit
  'appel','peer','banaan','sinaasappel','mandarijn','citroen','druiven','aardbei','kiwi','meloen','ananas',
  'avocado','tomaat','komkommer','paprika','wortel','ui','knoflook','sla','spinazie','rucola','broccoli',
  'bloemkool','courgette','aubergine','prei','aardappel','champignon','radijs','bosui','peterselie','basilicum','gember',
  // Vlees vis
  'kipfilet','kipdij','kippenpoot','kalkoen','rundergehakt','gehakt','biefstuk','varkenshaas','speklap',
  'spek','bacon','ham','salami','worst','rookworst','knakworst','zalm','tonijn','kabeljauw','garnalen','vis',
  // Diepvries
  'pizza','friet','ijs','ijsje','vissticks','loempia','doperwten','spinaziepuree',
  // Houdbaar
  'pasta','spaghetti','penne','macaroni','lasagne','rijst','basmati','noedels','mie','olijfolie','zonnebloemolie',
  'azijn','sojasaus','ketchup','mayonaise','mosterd','sambal','curry','bouillon','tomatenblok','tomatenpuree',
  'pesto','kikkererwten','bonen in blik','linzen','soep','bloem','suiker','honing','jam','hagelslag','pindakaas',
  'choco','nutella','noten','rozijnen','muesli','cornflakes','havermout','rijstwafels','olijven','augurken',
  // Snacks dranken
  'chips','popcorn','chocolade','reep','snoep','drop','koekjes','stroopwafel','speculaas','liga',
  'water','spa','vruchtensap','sinaasappelsap','appelsap','cola','fanta','sprite','ice tea','aquarius',
  'dubbelfris','red bull','bier','heineken','wijn','rode wijn','witte wijn','koffie','koffiepads','thee',
  // Drogist
  'shampoo','douchegel','tandpasta','tandenborstel','deodorant','bodylotion','zonnebrand','paracetamol',
  'ibuprofen','pleisters','luiers','babydoekjes','maandverband',
  // Huishouden
  'wc papier','keukenpapier','tissues','vuilniszakken','vaatwastabletten','afwasmiddel','allesreiniger',
  'wasmiddel','wasverzachter','aluminiumfolie','vershoudfolie','bakpapier','sponzen','batterijen',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Auth/blocked (${res.status})`);
      }
      if (!res.ok && res.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function getToken() {
  const res = await fetchWithRetry('https://api.ah.nl/mobile-auth/v1/auth/token/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ clientId: 'appie' }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('No access_token in response');
  return j.access_token;
}

async function search(token, query, page = 0) {
  const url = `https://api.ah.nl/mobile-services/product/search/v2?query=${encodeURIComponent(query)}&size=${PAGE_SIZE}&page=${page}`;
  const res = await fetchWithRetry(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': UA,
      'X-Application': APP,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(`  ! search "${query}" page ${page}: HTTP ${res.status}`);
    return { products: [], page: { totalPages: 0 } };
  }
  return res.json();
}

// Minimaal vertaal-schema: alleen wat we echt nodig hebben in de PWA.
function normalize(p) {
  const out = {
    id: p.webshopId ? `wi${p.webshopId}` : (p.hqId ? `hq${p.hqId}` : null),
    name: p.title,
    brand: p.brand || null,
    unit: p.salesUnitSize || null,
    price: typeof p.priceBeforeBonus === 'number' && p.priceBeforeBonus > 0 ? p.priceBeforeBonus : (p.currentPrice ?? null),
    bonus_price: typeof p.currentPrice === 'number' && typeof p.priceBeforeBonus === 'number' && p.currentPrice < p.priceBeforeBonus ? p.currentPrice : null,
    unit_price: p.unitPriceDescription || null,
    bonus: null,
    image: null,
    category: p.mainCategory || p.subCategory || null,
  };
  // Foto: pak 200x200 of dichtstbij
  if (Array.isArray(p.images) && p.images.length) {
    const small = p.images.find(i => i.width === 200) || p.images.find(i => i.width <= 400) || p.images[0];
    out.image = small.url;
  }
  // Bonus-info
  if (p.bonusMechanism || p.discountType || p.bonusStartDate) {
    out.bonus = {
      mechanism: p.bonusMechanism || null,
      start: p.bonusStartDate || null,
      end: p.bonusEndDate || null,
      type: p.discountType || null,
    };
  }
  return out;
}

async function main() {
  console.log(`AH scraper — ${SEARCH_TERMS.length} zoektermen`);
  const token = await getToken();
  console.log('Token OK');

  const byId = new Map();
  let totalCalls = 0;
  let totalFound = 0;

  for (const term of SEARCH_TERMS) {
    let added = 0;
    const first = await search(token, term, 0);
    totalCalls++;
    for (const p of (first.products || [])) {
      const n = normalize(p);
      if (n.id && !byId.has(n.id)) { byId.set(n.id, n); added++; }
    }
    totalFound += (first.products || []).length;
    console.log(`  ${term.padEnd(20)} → ${(first.products || []).length} resultaten, ${added} nieuw (totaal ${byId.size})`);
    await sleep(DELAY_MS);
  }

  const out = {
    store: 'ah',
    location: 'Dalempromenade Tilburg',
    scraped_at: new Date().toISOString(),
    search_terms: SEARCH_TERMS.length,
    api_calls: totalCalls,
    raw_results: totalFound,
    product_count: byId.size,
    products: Array.from(byId.values()),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
  console.log(`\n✓ Geschreven: ${OUT}`);
  console.log(`  ${byId.size} unieke producten, ${totalCalls} API calls`);
}

main().catch(err => {
  console.error('FOUT:', err.message);
  process.exit(1);
});

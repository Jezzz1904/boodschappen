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
  'wraps','pita','rozijnenbol','krentenbol','saucijzenbrood','worstenbroodje','bolletjes','bollen',
  // Groente fruit
  'appel','peer','banaan','sinaasappel','mandarijn','citroen','druiven','aardbei','kiwi','meloen','ananas',
  'avocado','tomaat','komkommer','paprika','wortel','ui','knoflook','sla','spinazie','rucola','broccoli',
  'bloemkool','courgette','aubergine','prei','aardappel','champignon','radijs','bosui','peterselie','basilicum','gember',
  // Vlees vis
  'kipfilet','kipdij','kippenpoot','kalkoen','rundergehakt','gehakt','biefstuk','varkenshaas','speklap',
  'spek','bacon','ham','salami','worst','rookworst','knakworst','zalm','tonijn','kabeljauw','garnalen','vis',
  'wokkip','wokrundvlees','saté','saté kip','saté varken','kipschnitzel','varkensschnitzel',
  // Vleeswaren & beleg
  'vleeswaren','rookvlees','pastrami','cervelaat','leverworst','boterhamworst','filet americain',
  'chorizo beleg','rosbief','kipfilet beleg','kalkoenfilet','smeerleversworst',
  // Diepvries
  'pizza','friet','ijs','ijsje','vissticks','loempia','doperwten','spinaziepuree','aardappelpartjes','aardappelschijfjes',
  'diepvries groente','kroket','bitterballen','frikandel','diepvries maaltijd',
  // Verse pasta & pastasauzen
  'verse pasta','tortelloni','cappelletti','ravioli','gnocchi','tortellini','verse gnocchi',
  'pastasaus','pestosaus','pastasaus carbonara','pastasaus bolognese',
  // Zuivel uitgebreid
  'skyr','griekse yoghurt','drinkyoghurt','kwarkdessert','hüttenkäse','cottage cheese',
  'hummus','tzatziki','guacamole','tapenade',
  // Houdbaar
  'pasta','spaghetti','penne','macaroni','lasagne','rijst','basmati','noedels','mie','olijfolie','zonnebloemolie',
  'azijn','sojasaus','ketchup','mayonaise','calvé mayonaise','calvé','remia mayonaise','mosterd','sambal','curry','bouillon','tomatenblok','tomatenpuree',
  'pesto','kikkererwten','bonen in blik','linzen','soep','bloem','suiker','honing','jam','hagelslag','pindakaas',
  'choco','nutella','noten','rozijnen','muesli','cornflakes','havermout','rijstwafels','olijven','augurken',
  'honey loops','hoops','frosties','coco pops','cheerios','granola','fruit loops',
  'quinoa','bulgur','couscous','lijnzaad','chiazaad','glutenvrij brood','glutenvrij pasta',
  // Snacks & dranken
  'chips','lays','croky','doritos','pringles','cheetos','bugles','tortilla chips','nachos',
  'popcorn','chocolade','reep','snoep','drop','koekjes','stroopwafel','speculaas','liga','ontbijtkoek',
  'water','spa','vruchtensap','sinaasappelsap','appelsap','cola','fanta','sprite','ice tea','aquarius',
  'dubbelfris','red bull','bier','heineken','wijn','rode wijn','witte wijn','koffie','koffiepads','thee',
  'tonic','royal club tonic','ginger beer','bitter lemon','radler','kombucha','kokoswater',
  'coca cola zero','coca cola light','fanta orange','sprite zero',
  'jenever','wodka','rum','port','sherry','advocaat','prosecco','cava','champagne',
  // Sport & gezondheid
  'proteïnereep','eiwitreep','eiwitshake','proteïne shake','creatine','havermoutrepen',
  // Drogist
  'shampoo','douchegel','tandpasta','tandenborstel','deodorant','bodylotion','zonnebrand','paracetamol',
  'ibuprofen','pleisters','luiers','babydoekjes','maandverband','scheerschuim','condoom',
  // Baby
  'babyvoeding','babymelk','babygraan','babygroente','babyfruit','pap baby',
  // Dier
  'kattenvoer','hondenvoer','kattenbakkorrels','hondensnacks',
  // Wereldkeuken
  'conimex','kroepoek','kokosmelk','nasigoreng','bamigoreng','ketjap','seroendeng',
  'heinz ketchup','heinz','worcestersaus','go-tan','roti','papadum','naan brood',
  // Huishouden
  'wc papier','keukenpapier','tissues','vuilniszakken','vaatwastabletten','afwasmiddel','allesreiniger',
  'wasmiddel','wasverzachter','aluminiumfolie','vershoudfolie','bakpapier','sponzen','batterijen',
  'wc reiniger','badkamerreiniger','vloerreinger','keukenreiniger',
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

// Bereken effectieve per-stuk bonus-prijs uit discountLabels.
// AH geeft `currentPrice: null` voor conditionele kortingen ("2e gratis", "X voor Y",
// "per 100g voor Y") — daar moet je 'm zelf afleiden uit de label-structuur.
function computeEffectivePrice(p) {
  const before = typeof p.priceBeforeBonus === 'number' ? p.priceBeforeBonus : null;
  const cur = typeof p.currentPrice === 'number' ? p.currentPrice : null;
  // Geen bonus of geen labels: simpele fall-through.
  if (!p.discountLabels || !p.discountLabels.length) {
    return cur != null && before != null && cur < before ? cur : null;
  }
  // Eerste label dat een effectieve prijs oplevert telt.
  for (const dl of p.discountLabels) {
    switch (dl.code) {
      case 'DISCOUNT_BUNDLE_BULK':
      case 'DISCOUNT_BUNDLE':
      case 'DISCOUNT_PERCENTAGE':
      case 'DISCOUNT_FIXED_PRICE':
        // currentPrice is hier al de gediscount totaal-prijs per verpakking
        if (cur != null && before != null && cur < before) return cur;
        if (dl.code === 'DISCOUNT_FIXED_PRICE' && typeof dl.price === 'number') return dl.price;
        if (dl.code === 'DISCOUNT_PERCENTAGE' && typeof dl.percentage === 'number' && before != null) {
          return +(before * (1 - dl.percentage / 100)).toFixed(2);
        }
        break;
      case 'DISCOUNT_X_FOR_Y':
        // "4 voor 7.29" → 7.29 / 4 = 1.82 per stuk
        if (typeof dl.price === 'number' && typeof dl.count === 'number' && dl.count > 0) {
          return +(dl.price / dl.count).toFixed(2);
        }
        break;
      case 'DISCOUNT_ONE_FREE': {
        // "2e gratis" → count=2, freeCount=1 → betaal 1, krijg 2 = before/2
        // "2+1 gratis" → count=3, freeCount=1 → betaal 2, krijg 3 = before * 2/3
        // "2e halve prijs" → count=2, free=0.5 → betaal 1.5, krijg 2 = before * 0.75
        let count = dl.count, free = dl.freeCount;
        if (count == null || free == null) {
          const m = (p.bonusMechanism || dl.defaultDescription || '').toLowerCase();
          if (/2e gratis/.test(m)) { count = 2; free = 1; }
          else if (/1\s*\+\s*1/.test(m)) { count = 2; free = 1; }
          else if (/2\s*\+\s*1/.test(m)) { count = 3; free = 1; }
          else if (/3\s*\+\s*1/.test(m)) { count = 4; free = 1; }
          else if (/2e halve/.test(m)) { count = 2; free = 0.5; }
        }
        // AH vult priceBeforeBonus soms niet in bij conditionele deals — gebruik dan currentPrice
        const basePrice = before ?? cur;
        if (basePrice != null && count > 0 && free != null) {
          const paid = count - free;
          if (paid > 0) return +(basePrice * paid / count).toFixed(2);
        }
        break;
      }
      case 'DISCOUNT_WEIGHT':
        // "per 100g voor 2.39" — voor lijst-vergelijking laten we de stuks-prijs staan,
        // bonus_price wordt de stuks-prijs als die lager is dan voor-prijs (vaak het geval)
        if (cur != null && before != null && cur < before) return cur;
        break;
    }
  }
  // Laatste fallback
  return cur != null && before != null && cur < before ? cur : null;
}

// Minimaal vertaal-schema: alleen wat we echt nodig hebben in de PWA.
function normalize(p) {
  const before = typeof p.priceBeforeBonus === 'number' && p.priceBeforeBonus > 0 ? p.priceBeforeBonus : null;
  const cur = typeof p.currentPrice === 'number' && p.currentPrice > 0 ? p.currentPrice : null;
  const out = {
    id: p.webshopId ? `wi${p.webshopId}` : (p.hqId ? `hq${p.hqId}` : null),
    name: p.title,
    brand: p.brand || null,
    unit: p.salesUnitSize || null,
    // price = de normale (niet-bonus) prijs
    price: before ?? cur,
    bonus_price: computeEffectivePrice(p),
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
  // Bonus-info — alleen flaggen als er actief een aanbieding loopt
  if (p.isBonus || p.bonusMechanism || p.bonusStartDate) {
    out.bonus = {
      mechanism: p.bonusMechanism || (p.discountLabels?.[0]?.defaultDescription) || null,
      start: p.bonusStartDate || null,
      end: p.bonusEndDate || null,
      type: p.discountType || null,
      // Structurele "permanente" 5%-kortingen (einddatum 2999) markeren zodat de PWA
      // ze niet als week-aanbieding ziet. AH's isInfiniteBonus-veld is onbetrouwbaar
      // (vaak false terwijl einddatum 2999-12-31 is), dus zelf detecteren.
      infinite: !!p.isInfiniteBonus || (p.bonusEndDate && p.bonusEndDate > '2030-01-01'),
      // Conditionele bonus (alleen voordelig vanaf X stuks) — voor "2e gratis" e.d.
      conditional: !!p.isStapelBonus || (p.discountLabels || []).some(dl =>
        ['DISCOUNT_ONE_FREE','DISCOUNT_X_FOR_Y','DISCOUNT_BUNDLE'].includes(dl.code)
      ),
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

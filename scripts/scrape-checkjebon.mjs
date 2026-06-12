// Haalt de checkjebon dataset (alle NL supermarkten, dagelijks geupdate) en
// schrijft per winkel een geslankt data/<store>.json in hetzelfde schema als ah.json.
// checkjebon heeft GEEN bonus/aanbieding-data — alleen reguliere prijzen.
// Voor AH gebruiken we onze eigen mobile-API scraper (die wel bonus heeft).
//
// Run lokaal:  node scripts/scrape-checkjebon.mjs jumbo
//              node scripts/scrape-checkjebon.mjs jumbo plus lidl

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://raw.githubusercontent.com/supermarkt/checkjebon/main/data/supermarkets.json';

// Welke winkels mag je opvragen (voorkomt typo's, en AH sluiten we expres uit)
const ALLOWED = new Set(['jumbo', 'plus', 'lidl', 'dirk', 'dekamarkt', 'hoogvliet', 'aldi', 'coop', 'spar', 'vomar', 'poiesz']);

// Categorie-classifier voor producten zonder categorie-data (checkjebon levert die niet).
// Volgorde = prioriteit: niet-food/bewerkt EERST, zodat "Appel afwasmiddel" → huishouden
// en "Appelsap" → dranken i.p.v. groente. Geeft een user-categorie-id terug (zoals de PWA gebruikt).
const CAT_RULES = [
  ['huishouden', ['wc papier','toiletpapier','keukenpapier','tissue','vuilniszak','afvalzak','vaatwas','afwasmiddel','allesreiniger','schoonmaak','wasmiddel','wasverzachter','wascapsules','vlekverwijderaar','aluminiumfolie','vershoudfolie','bakpapier','boterhamzakjes','spons','vaatdoek','dweil','luchtverfrisser','wc reiniger','bleek','batterij','lampen','aansteker','lucifers','kaars','aanmaakblok','houtskool','zakdoek']],
  ['drogist',    ['shampoo','conditioner','douchegel','handzeep','tandpasta','tandenborstel','flosdraad','mondwater','deodorant','bodylotion','dagcreme','nachtcreme','zonnebrand','aftersun','mascara','lippenstift','foundation','wattenstaafjes','wattenschijfjes','maandverband','tampons','inlegkruisjes','luiers','babydoekjes','billendoekjes','paracetamol','ibuprofen','aspirine','pleister','scheermes','scheerschuim','vitamine','supplement','condoom','zeep']],
  ['dranken',    ['sap','sapje','frisdrank','cola','fanta','sprite','7up','ice tea','aquarius','rivella','dubbelfris','energy','red bull','monster','bier','pils','speciaalbier','wijn','rose','prosecco','cava','champagne','wodka','whisky','rum','gin','likeur','koffie','koffiepad','koffiecup','senseo','nespresso','dolce gusto','thee','rooibos','water','spa','mineraalwater','smoothie','limonade','ranja','siroop']],
  ['diepvries',  ['diepvries','pizza','ijs','ijsje','vissticks','loempia','bevroren','frites']],
  ['snacks',     ['chips','nootjes','borrelnoten','popcorn','chocolade','chocola','reep','snoep','drop','wine gums','koekjes','speculaas','stroopwafel','liga','sultana','candy','snickers','mars','twix','bounty','kitkat','oreo','pringles','tuc','wafels','wafel']],
  ['vlees',      ['kip','kipfilet','kipdij','kalkoen','rundvlees','gehakt','biefstuk','varkens','speklap','spek','bacon','ham','salami','worst','rookworst','knakworst','braadworst','frikandel','vis','zalm','tonijn','kabeljauw','tilapia','garnalen','mosselen','haring','makreel','sardines','schol','schnitzel','slavink','hamburger']],
  ['zuivel',     ['melk','karnemelk','yoghurt','kwark','vla','room','slagroom','kookroom','creme fraiche','boter','margarine','kaas','mozzarella','feta','parmezaan','geitenkaas','brie','camembert','huttenkase','ei ','eieren','pudding','sojadrink','havermelk','amandelmelk']],
  ['bakkerij',   ['brood','stokbrood','baguette','ciabatta','pistolet','broodje','bolletje','croissant','krentenbol','rozijnenbol','beschuit','wraps','tortilla','pita','naan','bagel','cake','taart','muffin']],
  ['houdbaar',   ['pasta','spaghetti','penne','macaroni','lasagne','rijst','basmati','quinoa','couscous','bulgur','noedels','mie','olijfolie','zonnebloemolie','azijn','balsamico','sojasaus','ketchup','mayonaise','mosterd','sambal','curry','bouillon','tomatenpuree','passata','pesto','kikkererwten','linzen','soep','bloem','suiker','honing','jam','hagelslag','pindakaas','nutella','noten','rozijnen','muesli','cornflakes','havermout','rijstwafels','olijven','augurken','blik']],
  ['groente',    ['appel','peer','banaan','sinaasappel','mandarijn','citroen','limoen','druiven','kiwi','aardbei','framboos','meloen','ananas','perzik','nectarine','pruim','avocado','tomaat','komkommer','paprika','wortel','ui','knoflook','sla','andijvie','spinazie','rucola','broccoli','bloemkool','courgette','aubergine','prei','aardappel','champignon','radijs','spruitjes','bonen','sperziebonen','asperges','mais','bosui','peterselie','basilicum','gember','groente','fruit']],
];
function classify(name, size) {
  const n = ' ' + name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
  let cat = 'overig';
  for (const [c, words] of CAT_RULES) {
    let hit = false;
    for (const w of words) {
      const re = new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(n)) { hit = true; break; }
    }
    if (hit) { cat = c; break; }
  }
  // Fruit/groente in een vloeibaar formaat is vrijwel altijd sap/drinken (bv "1Fruit Appel 200ml").
  if (cat === 'groente' && size && /\b(ml|cl|liter|l)\b/i.test(size)) cat = 'dranken';
  return cat;
}

async function main() {
  const stores = process.argv.slice(2).map(s => s.toLowerCase());
  if (!stores.length) {
    console.error('Gebruik: node scripts/scrape-checkjebon.mjs <store> [store...]');
    console.error('Bv: node scripts/scrape-checkjebon.mjs jumbo');
    process.exit(1);
  }
  for (const s of stores) {
    if (!ALLOWED.has(s)) {
      console.error(`Onbekende/niet-toegestane winkel: "${s}". Toegestaan: ${[...ALLOWED].join(', ')}`);
      process.exit(1);
    }
  }

  console.log('checkjebon dataset ophalen...');
  const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download faalde: HTTP ${res.status}`);
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error('Onverwacht dataformaat (geen array)');

  await mkdir(resolve(ROOT, 'data'), { recursive: true });

  for (const storeName of stores) {
    const store = all.find(s => (s.n || '').toLowerCase() === storeName);
    if (!store || !Array.isArray(store.d)) {
      console.warn(`! "${storeName}" niet gevonden in dataset — overgeslagen`);
      continue;
    }
    // checkjebon product: { n:naam, l:link-slug, p:prijs, s:formaat }
    const products = store.d
      .filter(p => p && p.n && typeof p.p === 'number')
      .map(p => {
        const o = { id: `${storeName.slice(0, 2)}_${p.l}`, name: p.n, price: p.p };
        if (p.s) o.unit = p.s;
        o.cat = classify(p.n, p.s);  // user-categorie-id voor categorie-boost in de PWA
        return o;
      });

    const out = {
      store: storeName,
      source: 'checkjebon',
      base_url: store.u || null,
      scraped_at: new Date().toISOString(),
      has_bonus: false,
      product_count: products.length,
      products,
    };
    const path = resolve(ROOT, `data/${storeName}.json`);
    await writeFile(path, JSON.stringify(out), 'utf8');
    const mb = (JSON.stringify(out).length / 1024 / 1024).toFixed(2);
    console.log(`✓ ${storeName.padEnd(10)} → ${products.length} producten (${mb} MB) → data/${storeName}.json`);
  }
}

main().catch(err => {
  console.error('FOUT:', err.message);
  process.exit(1);
});

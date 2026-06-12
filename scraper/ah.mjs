// Albert Heijn scraper — mobile API, anonieme token, één call per product.
// Geen account nodig, low rate; alleen voor persoonlijk gebruik.
const UA = 'Appie/8.22.3 Android/13';
const APP = 'AHWEBSHOP';
const BASE = 'https://api.ah.nl';

let _token = null;
let _tokenAt = 0;

async function getToken() {
  if (_token && Date.now() - _tokenAt < 45 * 60 * 1000) return _token;
  const r = await fetch(`${BASE}/mobile-auth/v1/auth/token/anonymous`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'appie' }),
  });
  if (!r.ok) throw new Error(`AH token: ${r.status}`);
  _token = (await r.json()).access_token;
  _tokenAt = Date.now();
  return _token;
}

async function apiGet(path) {
  const tok = await getToken();
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': UA, Authorization: `Bearer ${tok}`, 'X-Application': APP },
  });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}

/** Zoek producten en geef genormaliseerd resultaat terug. */
export async function search(query, size = 10) {
  const data = await apiGet(`/mobile-services/product/search/v2?query=${encodeURIComponent(query)}&size=${size}`);
  const products = data.products || [];
  return products.map(normalize);
}

function normalize(p) {
  const onSale = p.currentPrice != null && p.currentPrice < (p.priceBeforeBonus ?? Infinity);
  return {
    id: p.webshopId,
    hqId: p.hqId,
    name: p.title,
    brand: p.brand,
    unit: p.salesUnitSize,
    unitPriceText: p.unitPriceDescription,
    category: p.mainCategory,
    subCategory: p.subCategory,
    isHuismerk: (p.shopType === 'AH' || (p.brand && /^AH( |$)/i.test(p.brand))),
    priceRegular: p.priceBeforeBonus ?? null,
    priceNow: p.currentPrice ?? p.priceBeforeBonus ?? null,
    onSale,
    bonusStart: p.bonusStartDate || null,
    bonusEnd: p.bonusEndDate || null,
    bonusMechanism: p.bonusMechanism || null,
    promotionType: p.promotionType || null,
    discountType: p.discountType || null,
    image: p.images?.find(i => i.width === 200)?.url || p.images?.[0]?.url || null,
    available: p.orderAvailabilityStatus === 'IN_ASSORTMENT',
  };
}

/** Best matchend product voor een gewone zoekterm. Voorkeur: geen tray/bulk, beschikbaar. */
export function pickBest(results, query) {
  const q = query.toLowerCase();
  const candidates = results.filter(r => r.available);
  if (!candidates.length) return null;
  // Score: exact title-woord match + niet-tray + huismerk-bonus + onSale-bonus
  const scored = candidates.map(p => {
    const t = (p.name || '').toLowerCase();
    let s = 0;
    if (t.startsWith('ah ') || t.startsWith(q)) s += 3;
    if (t.includes(q)) s += 2;
    if (/(tray|krat|pack|bulk|6-pack|8-pack|12-pack|24-pack)/i.test(p.name)) s -= 4;
    if (/(family|XXL|jumbo|maxi)/i.test(p.name)) s -= 1;
    if (p.onSale) s += 1;
    if (p.isHuismerk) s += 0.5;
    return { p, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].p;
}

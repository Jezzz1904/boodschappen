// Match-evaluatie — draait IN DE APP (browser), omdat de matching-code daar leeft.
//
// Gebruik: open de app (lokaal of live), wacht tot de prijzen geladen zijn, en
// voer in de console uit:
//     await (await fetch('scripts/match-eval.browser.js')).text().then(eval); runMatchEval()
//
// Per alledaags product staat hieronder wat er *duidelijk fout* is: "tomaten"
// mag geen ketchup worden, "melk" geen karnemelk of chocolademelk. Het script
// telt per winkel hoeveel matches daaronder vallen, en hoeveel producten
// helemaal geen match krijgen. Dat geeft een getal om wijzigingen aan de
// matcher tegen af te zetten, in plaats van één geval te repareren en vijf
// andere stil te breken.
//
// Het is geen volledige grondwaarheid: een match die níét onder het
// fout-patroon valt is niet per se goed. Wel vangt het de bekende fouten.

var MATCH_EVAL = [
  ['tomaten',      /ketchup|saus|soep|puree|gepeld|passata|frito|sap\b|pizza|tapenade|pesto/i],
  ['komkommer',    /salade|chips/i],
  ['paprika',      /chips|poeder|saus|spread|kruiden|milde|gerooster|gemalen/i],
  ['uien',         /soep|chips|ringen|saus|poeder|gebakken|bosui/i],
  ['aardappelen',  /puree|chips|salade|kroket|frites|schijfjes|partjes/i],
  ['champignons',  /soep|saus/i],
  ['wortels',      /taart|sap\b|salade|cake/i],
  ['broccoli',     /soep|crème|creme|roerbak/i],
  ['prei',         /soep|stamppot/i],
  ['knoflook',     /saus|poeder|brood|olie|pasta/i],
  ['spinazie',     /soep|lasagne|pasta/i],
  ['appels',       /sap\b|moes|taart|flap|stroop|azijn|chips|gebak|thee/i],
  ['bananen',      /chips|brood|taart|yoghurt|smoothie|snoep|bakbanan|bakmix/i],
  ['sinaasappels', /sap\b|marmelade|limonade|chocola/i],
  ['citroen',      /sap\b|thee|limonade|taart|gras|melisse|ijs|koek/i],
  ['melk',         /karne|choco|kokos|amandel|haver|soja|rijst|brioche|poeder|condens|koffiemelk|melkbrood|melkchocola|melkmeisje/i],
  ['yoghurt',      /drink|ijs|koek|reep|rozijn|dressing|saus/i],
  ['kaas',         /saus|soep|stengel|cracker|chips|koek|taart|fondue|broodje|soufflé|souffle|burger|leverkaas|croissant|grillworst|kruier/i],
  ['boter',        /koek|bladerdeeg|pinda|hamburger|bijl|saus|kruidenboter|knoflookboter|boterham/i],
  ['room',         /ijs|kaas|boter|saus|soep/i],
  ['eieren',       /chocola|paas|noedels|salade|spread/i],
  ['brood',        /beleg|crouton|kruim|chips|pudding|mix|bakmix|rooster|zak/i],
  ['rijst',        /wafel|melk|koek|pap|cracker|noedel|azijn|bloemkool/i],
  ['pasta',        /saus|salade|pesto|bord|speculoos|choco|hazelnoot|pinda/i],
  ['kipfilet',     /saté|sate|soep|salade|spread|beleg|chips|kruiden/i],
  ['gehakt',       /ballen|saus|kruiden|mix|nasi/i],
  ['worst',        /broodje|soep|stamppot/i],
  ['zalm',         /salade|spread|tapas|saus|lasagne|quiche|bladerdeeg|schotel/i],
  ['tonijn',       /salade|spread|saus|kattenvoer|soup/i],
  ['spek',         /pannenkoek|spekjes|snoep|schuim/i],
  ['koffie',       /koek|creamer|melk|ijs|beker|mok|filterhouder|likeur|snoep|bonbon|koffieroom|gekoeld|wafel/i],
  ['thee',         /ijs|koek|glas|lepel|pot|doek|lichtje/i],
  ['suiker',       /vrij|wafel|spin|snoep|gelei/i],
  ['honing',       /koek|mosterd|drop|snoep/i],
  ['water',        /meloen|ijs|kers|verf|fles\b|rozenwater/i],
  ['bloem',        /kool|bollen|pot|vaas/i],
  ['peper',        /koek|noten|munt|saus|chips|cervelaat/i],
  ['olijfolie',    /tapenade|chips|crackers/i],
  ['pindakaas',    /koek|reep|snoep|ijs/i],
  ['hagelslag',    /koek|taart|ijs/i],
  ['chips',        /schip|chipolata/i],
  ['cola',         /snoep|flesjes snoep|zuur|gom/i],
  ['bier',         /azijn|glas|worst|brood|snoep/i],
  ['wijn',         /azijn|glas|gom|saus|snoep|cervelaat/i],
  ['tandpasta',    /\bhouder\b/i],
  ['shampoo',      /\bhouder\b/i],
  ['afwasmiddel',  /\bhouder\b/i],
  ['wc papier',    /\bhouder\b|reiniger/i],
];

function runMatchEval(opts = {}) {
  const stores = STORES.filter(s => !s.manual && storeData[s.id]?.products?.length);
  matchCache.clear();
  const fout = [], geen = [], perWinkel = {};
  for (const s of stores) perWinkel[s.id] = { fout: 0, geen: 0 };
  for (const [item, bad] of MATCH_EVAL) {
    const cat = guessCategory(item);
    for (const s of stores) {
      const m = findStoreMatch(s.id, item, cat);
      if (!m) { geen.push(`${item} @ ${s.name}`); perWinkel[s.id].geen++; continue; }
      if (bad.test(m.p.name)) {
        fout.push(`${item} @ ${s.name} → ${m.p.name}`);
        perWinkel[s.id].fout++;
      }
    }
  }
  const totaal = MATCH_EVAL.length * stores.length;
  const res = {
    gevallen: totaal,
    fout: fout.length,
    geenMatch: geen.length,
    perWinkel,
    foutLijst: fout,
    geenLijst: geen,
  };
  if (opts.snapshot) {
    // Volledige toewijzing, om voor/na per item te kunnen vergelijken.
    res.snapshot = {};
    for (const [item] of MATCH_EVAL) {
      const cat = guessCategory(item);
      for (const s of stores) {
        const m = findStoreMatch(s.id, item, cat);
        res.snapshot[`${item}@${s.id}`] = m ? m.p.name : null;
      }
    }
  }
  return res;
}

// Beoordeelt een eerder opgeslagen snapshot met de huidige patronen, zodat
// voor en na met dezelfde maatstaf gemeten worden.
function scoreSnapshot(snap) {
  const fout = [];
  for (const [item, bad] of MATCH_EVAL) {
    for (const [k, v] of Object.entries(snap)) {
      if (k.split('@')[0] === item && v && bad.test(v)) fout.push(k + ' → ' + v);
    }
  }
  return fout;
}

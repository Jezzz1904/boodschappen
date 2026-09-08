# Boodschappenheld — UX- en GUI-verbeterplan

Gemeten op de draaiende app (375×812 mobiel + 1280×900 desktop) op 2026-09-08.
Alle getallen hieronder komen uit metingen in de browser, niet uit schattingen.

---

## 1. Wat er nu misgaat

### 1.1 Opstarten: 5,6 MB over de lijn, 144 MB heap

| Bestand | Ruw | Gzip | Gecached? |
|---|---|---|---|
| `data/ah.json` | 2,5 MB | 322 KB | IndexedDB ✅ |
| `data/jumbo.json` | 2,7 MB | 553 KB | IndexedDB ✅ |
| `data/plus.json` | 2,3 MB | 436 KB | IndexedDB ✅ |
| `data/lidl.json` | 1,6 MB | 309 KB | IndexedDB ✅ |
| **`data/price-history.json`** | **42,8 MB** | **4,0 MB** | **nee ❌** |

`loadPriceHistory()` (app.js:2895) haalt de prijshistorie op met een
`?v=` + `Date.now()` cache-buster. Die maakt elke URL uniek, dus:

- de HTTP-cache slaat nooit aan → **4 MB download bij élke start**, ook warm;
- de service worker (`sw.js`) zet elke unieke URL apart in Cache Storage →
  de cache groeit met 4 MB per start en wordt nooit geraakt;
- 42,8 MB JSON wordt geparsed en blijft resident: **144 MB JS-heap**,
  65.018 producten × gemiddeld 24,7 prijspunten = 1,6 miljoen datapunten.

Op een middenklasse telefoon is dat traag tot fataal.

**De data is bijna volledig redundant.** De meeste opeenvolgende prijspunten
zijn identiek (`[ts,1.89]` twaalf keer achter elkaar). Twee metingen:

- **Run-length encoding** (alleen prijs*wijzigingen* bewaren):
  1.604.872 → 68.084 entries, 42,8 MB → **4,3 MB ruw** (−90%).
- **Alleen de trend die de app gebruikt** (`getPriceTrend` wil enkel
  `diff`, `pct`, `isLowest`): **136 KB voor 2.726 producten** (−99,7%).
  Alle andere producten hebben een vlakke prijs en géén 30-daagse low.

### 1.2 De lijst — het hoofdscherm — is onbruikbaar dicht

Gemeten op 375×812 met 12 producten:

- **576 px chrome boven het eerste product.** Header 66 + tabs 47 +
  invoerkaart 125 + deelbalk 99 + prijssamenvatting 147. Op een 812 px scherm
  zie je bij openen **nul producten**; de actiebalk onderaan eet de rest op.
- **Producten zijn gemiddeld 207 px hoog** (155–289 px), want alle vier de
  winkelprijzen staan altijd uitgeklapt. 12 producten = 2.481 px lijst,
  3.131 px document — **vier schermen scrollen voor een gewone weeklijst**.
- De deelbalk (99 px) staat er permanent, ook als je niets deelt.
- De prijssamenvatting (147 px) herhaalt wat de Route-tab beter laat zien.

### 1.3 Tikdoelen en typografie onder de minimumnorm

Niets in een productrij haalt de 44×44 px die iOS en Android voorschrijven:

| Element | Gemeten |
|---|---|
| `.cmp-watch` (☆ volgen) | **15×17 px** |
| `.cmp-flag` (🚩 melden) | **26×17 px** |
| `.cmp-row` (prijs kiezen) | 193×**17 px** |
| `.route-item-check` | 22×22 px |
| `.item-note-btn` (✏️) | 27×27 px |
| `.check` (afvinken) | 28×28 px |
| `.settings-btn` (⚙️) | 40×40 px |

**53 CSS-regels zetten `font-size` onder 12 px**, waarvan een reeks op 9–10 px
(`.route-item-bonus` 9px, `.store-chip` 9.5px, `.pick-bonus` 9px,
`.cmp-unit` 10.5px). In een supermarkt, met één hand, is dat onleesbaar.

### 1.4 Toegankelijkheid: vrijwel niets aanwezig

- `role="tablist"` / `role="tab"`: **0**. De vier tabs zijn losse knoppen
  voor een screenreader.
- `role="dialog"`: **0**. Zes modals zonder focus-trap, zonder Escape.
- `aria-live`: **0**. De toast (inclusief "ongedaan maken") wordt nooit
  voorgelezen.
- `:focus-visible`: **geen enkele regel**; alleen 7 `:focus`-regels op inputs.
  Toetsenbordnavigatie is volledig onzichtbaar.
- **~60 emoji-knoppen zonder `aria-label`**: elke 🚩 en ✏️ per product, plus
  💾 en 📤 in de actiebalk.
- 7 inputs zonder label.

### 1.5 Geen responsive layout

**0 media queries** in 1.175 regels CSS. Op 1280 px is het exact dezelfde
smalle telefoonkolom; op een tablet in landscape idem.

### 1.6 Renderlus bouwt alles opnieuw op

- **242 inline `onclick=`/`oninput=`-handlers**, gegenereerd als string in
  `innerHTML`.
- `render()` (app.js:2838) roept zeven render-functies aan en herbouwt de
  hele lijst; **19 ms op desktop**, dus grofweg 100–200 ms op een telefoon.
  Hij draait bij élk afvinken, élke aantalswijziging en élke toetsaanslag.
- Gevolg: scrollpositie, invoerfocus en open prijskiezers gaan verloren.

### 1.7 Vertrouwen in de matches

In de test met een alledaagse lijst:

- "Tomaten" → **"PLUS Tomaten ketchup"**
- "Melk" → "Biologisch PLUS Magere melk" (bio, niet de logische goedkoopste)

De correctie zit achter een 🚩 van 26×17 px. Een gebruiker die dit ziet,
vertrouwt het totaalbedrag niet meer — en het totaalbedrag is het hele punt
van de app.

Daarnaast adviseert de Route-tab standaard **"Splits over 4 winkels"** om
€7,62 te besparen. Vier winkels bezoeken voor €7,62 is voor de meeste mensen
geen aanbod maar een straf; er zit geen weging op moeite.

### 1.8 Interactiemodel-details

- Tabs staan **bovenaan**; op een telefoon buiten duimbereik.
- Op de productrij tikken opent de **categoriekiezer** — niemand verwacht dat.
- Actiebalk: 💾 en 📤 zonder tekst; "✓ Klaar" is **amber/oranje** terwijl
  groen de primaire merkkleur is — het leest als een waarschuwing.

### 1.9 Wat wél goed is (behouden)

- De **Route-tab** heeft een heldere hiërarchie: winkelblok, rij per product,
  prijs rechts uitgelijnd. Dit is het patroon dat de Lijst-tab moet overnemen.
- **Winkelmodus** is echt goed: grote regels, grote vinkjes, chrome weg,
  wake-lock aan.
- Donker thema is compleet en reageert live op de systeeminstelling.
- IndexedDB-cache per winkel + `scraped_at`-controle.
- `viewport-fit=cover` met `env(safe-area-inset-*)` wordt gebruikt.

---

## 2. Plan

### Fase 1 — Opstarttijd (grootste winst, kleinste risico)

1. **Vervang `price-history.json` door voorberekende trends.**
   Laat `scripts/update-price-history.mjs` per product `diff`, `pct` en
   `isLowest` uitrekenen en die velden **direct in de winkel-JSON schrijven**.
   Resultaat: de losse fetch verdwijnt volledig; `getPriceTrend()` leest een
   veld in plaats van 65.018 keys te doorzoeken.
   *Alternatief als je de ruwe historie wilt houden voor grafieken: schrijf
   `data/price-trends.json` (136 KB) voor de app en bewaar de volledige
   historie als build-artefact buiten de app.*
2. **Haal de `Date.now()`-cache-buster weg** (app.js:2898). Gebruik in plaats
   daarvan een klein `data/manifest.json` met `scraped_at` per winkel; haal een
   winkelbestand alleen opnieuw op als die datum veranderd is.
3. **Slank de winkel-JSON af** in de scraper: alleen `id, name, price, unit,
   cat, bonus_price, bonus` en kort de slug-`id`'s in
   (`pl_11er-ambachtelijk-spek-rosti-zakje-350-g-675541` → numerieke id).
4. **Zet de prijshistorie in IndexedDB** met dezelfde versie-check als de
   winkeldata.

**Doel:** koude start < 3 s op 4G, warme start < 500 ms, heap < 40 MB.
Meetbaar met dezelfde methode als hierboven.

### Fase 2 — Event-delegatie (technische voorwaarde voor Fase 3)

**Twee aannames uit dit plan bleken bij meting niet te kloppen.** De 242
handlers waren live DOM-elementen, niet bronregels: het gaat om 70 sites in
`app.js` en 41 in `index.html`. En van de 11,7 ms die `render()` kostte bij
15 items zat **9,6 ms in `renderPriceComparison`** en maar 0,85 ms in de
`innerHTML`-toewijzing — de kosten zaten in het bouwen van de string, niet in
de DOM.

1. ✅ **Gerichte DOM-updates.** `renderPriceComparison` hangt niet af van
   `checked` of `qty`, dus afvinken hoeft de lijst niet te herbouwen.
   Afvinken 11,7 → 0,26 ms, aantal 11,7 → 0,23 ms, route-tik 12,4 → 0,74 ms.
   Die laatste is de belangrijkste: in winkelmodus 15-30 keer per bezoek.
2. ✅ **Delegatie voor lijst en route** (24 sites → 20 acties). Belangrijkste
   bijvangst: geen dubbele escaping meer. Een `onclick` is HTML én
   JavaScript, dus waarden gingen door `escapeHtml()` én een `\'`-replace.
3. ⬜ **Delegatie voor de rest** — instellingen, tips, bladeren, historie
   (46 sites in `app.js`, 41 in `index.html`).
4. ❌ **`render()` splitsen — vervalt.** Gebaseerd op de aanname dat typen de
   lijst herbouwt. Dat doet het niet: `onInputChange()` roept alleen
   `syncSubmitBtn()` en `renderSuggestions()` aan. De zes overige
   render-functies kosten samen ~0,1 ms.
5. ❌ **`findMatches()` memoïseren — vervalt.** Gemeten op 0,06 ms per
   aanroep, dus ~0,9 ms van de 11,7 ms. `findStoreMatch()` had de cache al.

Zonder deze fase wordt elke layoutwijziging in Fase 3 een string-plakfeest.

### Fase 3 — De lijst herontwerpen rond de lijst

1. **Navigatie naar onderen.** Bottom tab bar van 56 px + safe-area, in
   duimbereik. Header krimpt tot een compacte titelregel die wegscrollt.
2. **Invoer wordt één sticky veld.** Barcode (📷) en "Bladeren" schuiven als
   iconen ín het veld; de aparte knoprij verdwijnt.
3. **Deelbalk alleen tonen als er gedeeld wordt.** Starten/joinen verhuist
   naar Instellingen. (−99 px)
4. **Prijsvergelijking standaard ingeklapt.** Een productrij wordt:
   `[ vinkje ] Naam · 2×        Lidl €1,09  ⌄`
   Uitklappen op tik toont de vier winkels, de kiezer, volgen en melden.
   Doel: **~64 px per rij ingeklapt** in plaats van 207 px — 12 producten
   passen dan in ruim één scherm in plaats van vier.
5. **Vervang het prijssamenvattingsblok** door één sticky onderbalk:
   `€21,42 · optimaal · bespaar €7,62 →` die doorlinkt naar Route.
6. **Swipe-gebaren** op een rij: links = verwijderen (met undo-toast),
   rechts = afvinken. Daarmee kunnen ✏️ en ✕ uit de rij verdwijnen.
7. **Tik op de rij opent detail/uitklap**, niet de categoriekiezer. Categorie
   wijzigen verhuist naar het uitgeklapte paneel.

### Fase 4 — Tikdoelen, typografie, toegankelijkheid

1. **Ondergrens 44×44 px** voor alles wat aanklikbaar is; kleine iconen
   krijgen een onzichtbaar vergroot trefvlak (`::after` met negatieve inset).
2. **Typeschaal met ondergrens 12 px.** Vervang de 53 sub-12px-regels door
   drie stappen: 12 (meta) / 14 (body) / 17 (nadruk), plus 20/24 voor koppen.
3. **`aria-label` op elke emoji-knop** (🚩 "Verkeerd product melden",
   ✏️ "Notitie", 💾 "Lijst opslaan", 📤 "Lijst delen").
4. **Eén `:focus-visible`-token**, toegepast op alle interactieve elementen.
5. **Rollen toevoegen:** `tablist`/`tab`/`tabpanel` op de navigatie;
   `role="dialog"` + focus-trap + Escape op de zes modals; `aria-live="polite"`
   op `#toast`.
6. **Media queries toevoegen:** ≥768 px twee kolommen (lijst links,
   prijzen/route rechts); ≥1024 px een begrensde, gecentreerde container.
7. Actiebalk: "✓ Klaar" groen maken, 💾 en 📤 een tekstlabel geven.

### Fase 5 — Vertrouwen in de match

1. **"Klopt dit niet?" als echte knop** in de uitgeklapte rij, niet als vlagje
   van 26×17 px.
2. **Lage-zekerheidsmatches markeren** in plaats van ze als feit te tonen —
   toon bij twijfel op welke woorden gematcht is ("tomaten ↔ tomaten ketchup")
   zodat de fout meteen zichtbaar is.
3. **Route-advies wegen naar moeite:** bied drie opties in plaats van altijd
   de maximale splitsing — "beste 1 winkel", "beste 2 winkels", "volledig
   gesplitst" — met per optie de besparing.

### Fase 6 — Codebase splitsen (alleen als je doorgaat)

`app.js` is 5.402 regels / 288 KB zonder modules, met data, matching-logica en
alle rendering door elkaar. Splitsen naar `data/`, `matching/`, `render/`,
`features/` maakt alle bovenstaande fases goedkoper. Niet zichtbaar voor de
gebruiker; doe het pas als Fase 1–4 landen.

---

## 3. Volgorde en verwachte impact

| Fase | Merkbaar effect | Risico | Omvang |
|---|---|---|---|
| 1 — opstarttijd | Groot en direct | Laag | Klein (scrapers + 2 fetches) |
| 2 — delegatie | Onzichtbaar, maar vlotter | Middel | Middel (mechanisch) |
| 3 — lijst herontwerp | Grootste GUI-winst | Middel | Groot |
| 4 — touch/a11y/type | Overal merkbaar | Laag | Middel |
| 5 — vertrouwen | Hoog voor retentie | Laag | Klein |
| 6 — modulariseren | Geen | Laag | Groot |

Begin bij **Fase 1** — die is los te doen, meetbaar, en haalt 4 MB en ~100 MB
geheugen per sessie weg. **Fase 3** is de eigenlijke GUI-verbetering, maar
verdient **Fase 2** eerst als fundament.

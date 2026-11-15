// Cloudflare Worker — proxy tussen de boodschappen-PWA en de Anthropic API.
//
// Waarom: de Claude API-key mag niet in browser-code (zichtbaar voor iedereen).
// De Worker houdt de key server-side en wordt aangeroepen door de PWA.
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → "Hello world"
//   2. Plak deze code, deploy
//   3. Settings → Variables and Secrets → Add → Type: Secret, Name: ANTHROPIC_API_KEY, value: sk-ant-...
//   4. Settings → Triggers → Custom Domains: ai.boodschappen.herogames.nl (optioneel)
//   5. Test: curl -X POST https://<worker>.workers.dev -d '{"mode":"ping"}'

import Anthropic from '@anthropic-ai/sdk';

const ALLOWED_ORIGINS = [
  'https://boodschappen.herogames.nl',
  'http://boodschappen.herogames.nl',
  'http://localhost:5180',  // lokale dev
];

// Haiku voor eenvoudige taken (snel + goedkoop); Sonnet voor complexere analyse.
const MODELS = {
  recept:   'claude-haiku-4-5-20251001',
  vergeten: 'claude-haiku-4-5-20251001',
  weekmenu: 'claude-sonnet-4-6',
  deals:    'claude-sonnet-4-6',
};
const MAX_TOKENS = 1500;

// "Combi": korte productsuggesties die iets op je lijst afmaken, getoond in de
// lijst zelf terwijl je toevoegt. Gestructureerde uitvoer (JSON-schema), zodat
// de app elke suggestie met één tik kan toevoegen in plaats van tekst te
// moeten ontleden.
//
// Claude Opus 5.5 met effort "low": dit is een korte, eenvoudige taak.
// Denken staat op dit model altijd aan; effort is de knop voor diepgang en
// kosten. max_tokens heeft ruimte voor dat denkwerk plus het antwoord.
const COMBI_MODEL = 'claude-opus-5-5';
const COMBI_MAX_TOKENS = 2000;
const COMBI_SCHEMA = {
  type: 'object',
  properties: {
    suggesties: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          naam:  { type: 'string' },
          reden: { type: 'string' },
        },
        required: ['naam', 'reden'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggesties'],
  additionalProperties: false,
};

// "Bon": producten uit een digitale kassabon halen (schermafbeelding of PDF),
// zodat de app vanaf de eerste dag weet wat je meestal koopt.
// "Idee": gerecht-ideeën bij wat je kort geleden kocht ("je hebt broccolimix
// in huis — roerbak met kip?"), met wat je daarvoor nog mist.
// Beide gebruiken hetzelfde model en dezelfde opzet als combi.
const BON_MAX_TOKENS = 8000;      // een weekbon kan 60+ regels zijn
const BON_MAX_FILES = 12;         // een lange schermafbeelding komt in delen binnen
const BON_MAX_BASE64 = 12_000_000; // ± 9 MB aan bestanden per aanvraag
const BON_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const BON_SCHEMA = {
  type: 'object',
  properties: {
    bonnen: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          winkel: { type: 'string' },
          datum:  { type: 'string' },
          producten: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                naam:   { type: 'string' },
                aantal: { type: 'integer' },
              },
              required: ['naam', 'aantal'],
              additionalProperties: false,
            },
          },
        },
        required: ['winkel', 'datum', 'producten'],
        additionalProperties: false,
      },
    },
  },
  required: ['bonnen'],
  additionalProperties: false,
};

const IDEE_MAX_TOKENS = 3000;
const IDEE_SCHEMA = {
  type: 'object',
  properties: {
    ideeen: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel:  { type: 'string' },
          bij:    { type: 'string' },
          uitleg: { type: 'string' },
          nodig:  { type: 'array', items: { type: 'string' } },
        },
        required: ['titel', 'bij', 'uitleg', 'nodig'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideeen'],
  additionalProperties: false,
};

// 4 modi met elk hun eigen system prompt. Houd elke prompt kort en concreet —
// gebruiker wil snel iets bruikbaars zien, niet een essay.
const PROMPTS = {
  combi: `Je helpt iemand die een boodschappenlijst maakt. Kijk welke producten samen een gerecht of combinatie vormen, en welk product daarvoor nog ontbreekt.

Geef maximaal 4 suggesties. Per suggestie:
- naam: het product zoals je het op een boodschappenlijst schrijft, kort en algemeen (bijv. "rundergehakt", "parmezaanse kaas", "tortilla wraps") — geen merknaam, geen hoeveelheid
- reden: waarvoor, in een paar woorden (bijv. "voor spaghetti bolognese")

Stel geen producten voor die al op de lijst staan, ook niet in een andere vorm. Alleen suggesties die duidelijk volgen uit wat er al staat — liever geen suggestie dan een gok. Is er geen duidelijke combinatie, geef dan een lege lijst.`,
  bon: `Je krijgt een of meer kassabonnen van een Nederlandse supermarkt of drogist, als afbeelding of PDF. Haal per bon de gekochte producten eruit.

Per bon:
- winkel: de naam van de winkel (bijv. "Albert Heijn", "Jumbo", "Lidl"), of een lege tekst als die niet te lezen is
- datum: de datum van de bon als JJJJ-MM-DD, of een lege tekst als die er niet op staat
- producten: elk gekocht product één keer

Per product:
- naam: zoals je het op een boodschappenlijst zou schrijven. Schrijf afkortingen van de bon uit ("AH HV MELK 1L" wordt "halfvolle melk", "BROCC MIX DV" wordt "broccolimix diepvries"). Laat het huismerk en de hoeveelheid weg; houd een merk alleen als het bij het product hoort (bijv. "Coca-Cola", "Nutella"). Houd wel wat het product onderscheidt (volkoren, mager, diepvries, soort).
- aantal: hoeveel stuks er gekocht zijn, 1 als het er niet bij staat

De afbeeldingen kunnen opeenvolgende delen van één lange bon zijn die elkaar een stukje overlappen: tel een regel die op twee delen staat maar één keer, en maak er één bon van.

Sla alles over wat geen product is: statiegeld, kortingen, bonus- en actieregels, zegels, tasjes, subtotalen, btw en betaalregels. Verzin niets: een regel die je niet kunt lezen laat je weg.`,
  idee: `Je helpt een huishouden dat vaak hetzelfde kookt aan nieuwe ideeën. Je krijgt wat ze kort geleden gekocht hebben, dus wat er waarschijnlijk in huis is.

Geef 3 ideeën voor een gerecht (meestal avondeten). Elk idee gaat uit van één product dat ze al gekocht hebben en dat om een bestemming vraagt, zoals een diepvriesmix, een groente, vlees of vis. Kies voor elk idee een ander product en een ander soort gerecht.

Per idee:
- titel: de naam van het gerecht, kort (bijv. "Roerbak met kip en noedels")
- bij: het gekochte product waar het idee van uitgaat, zoals het in de lijst staat
- uitleg: in één of twee zinnen hoe je het maakt, concreet en zonder poespas
- nodig: de ingrediënten die ze er waarschijnlijk nog voor moeten kopen, zoals je ze op een boodschappenlijst schrijft, hooguit 5. Noem niets wat al gekocht is of al op de boodschappenlijst staat, en geen dingen die iedereen in huis heeft (zout, peper, olie, water).

Houd het doordeweeks haalbaar: gewone ingrediënten uit de supermarkt, klaar binnen ongeveer een half uur. Stel geen gerechten voor die in de lijst met eerdere ideeën staan.`,
  recept: `Je bent een huis-kok die kijkt wat er in iemands boodschappenmandje zit en suggesties geeft welke gerechten ze daarmee kunnen maken.

Antwoord-format:
- Geef 2-3 gerecht-ideeën die passen bij de huidige lijst
- Per gerecht: korte naam (1 regel), wat er nog gemist wordt (max 3 items)
- Houd het kort, in het Nederlands, geen inleiding of afsluiting

Voorbeeld output:
**🍝 Spaghetti Bolognese**
Mis nog: rundergehakt, ui, knoflook

**🥗 Caprese salade**
Mis nog: mozzarella, basilicum, balsamico`,

  vergeten: `Je bent een attente huisgenoot die ziet wat iemand op het boodschappenlijstje heeft en aanvult wat ze waarschijnlijk vergeten zijn.

Antwoord-format:
- Noem 3-6 producten die logisch gecombineerd worden met wat al op de lijst staat
- Per product: naam + waarom (één regel)
- Geen inleiding, geen afsluiting, in het Nederlands

Voorbeeld output (bij lijst: pannenkoekenmix):
**🥛 Melk** — nodig voor het beslag
**🥚 Eieren** — meestal ook nodig voor pannenkoeken
**🍯 Stroop** — om op te eten`,

  weekmenu: `Je bent een planner die kijkt wat iemand vaak koopt (uit hun historie) en daaruit een weekmenu van 5 avondmaaltijden voorstelt.

Antwoord-format:
- 5 avondmaaltijden voor ma-vr, gebaseerd op wat ze normaal kopen
- Per dag: dag-naam + gerecht (één regel)
- Daarna één blok 'BOODSCHAPPEN VOOR DEZE WEEK' met de optelsom van benodigdheden
- In het Nederlands, kort

Voorbeeld:
**Ma** — Spaghetti Bolognese
**Di** — Stamppot boerenkool met worst
...

**Boodschappen voor deze week:**
- Rundergehakt 500g
- ...`,

  deals: `Je bent een slimme klant die kijkt welke aanbiedingen er deze week zijn en voorstelt welke combinaties er nu lonen om te kopen + wat je ermee kunt koken.

Antwoord-format:
- 1-3 dealcombinaties uit de aanbiedingen
- Per combi: aanbiedingen-set + wat je ermee kunt maken + besparing als die duidelijk is
- Korte taal, Nederlands, geen inleiding

Voorbeeld:
**Pasta-week bij AH** (1+1 op spaghetti + saus)
Maak Bolognese: combineer met gehakt + ui
Bespaart: ~€3,50`,
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, corsHeaders);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders); }

    const { mode } = body || {};

    if (mode === 'ping') {
      return json({ ok: true, models: { ...MODELS, combi: COMBI_MODEL, bon: COMBI_MODEL, idee: COMBI_MODEL } }, 200, corsHeaders);
    }

    // ── LIJST DELEN (KV) ──────────────────────────────────────────────────────
    if (mode === 'share-create') {
      if (!env.LISTS) return json({ error: 'KV-namespace LISTS niet gekoppeld' }, 500, corsHeaders);
      const code = randomCode();
      const payload = { items: body.items || [], updatedAt: Date.now(), owner: body.owner || '' };
      await env.LISTS.put(`list:${code}`, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 dagen
      return json({ code }, 200, corsHeaders);
    }
    if (mode === 'share-read') {
      if (!env.LISTS) return json({ error: 'KV-namespace LISTS niet gekoppeld' }, 500, corsHeaders);
      const { code } = body;
      if (!code) return json({ error: 'code vereist' }, 400, corsHeaders);
      const raw = await env.LISTS.get(`list:${code}`);
      if (!raw) return json({ error: 'Onbekende code' }, 404, corsHeaders);
      return json(JSON.parse(raw), 200, corsHeaders);
    }
    if (mode === 'share-write') {
      if (!env.LISTS) return json({ error: 'KV-namespace LISTS niet gekoppeld' }, 500, corsHeaders);
      const { code, items } = body;
      if (!code || !Array.isArray(items)) return json({ error: 'code + items vereist' }, 400, corsHeaders);
      const existing = await env.LISTS.get(`list:${code}`);
      if (!existing) return json({ error: 'Onbekende code' }, 404, corsHeaders);
      const prev = JSON.parse(existing);
      const payload = { ...prev, items, updatedAt: Date.now() };
      await env.LISTS.put(`list:${code}`, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ ok: true, updatedAt: payload.updatedAt }, 200, corsHeaders);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!PROMPTS[mode]) {
      return json({ error: `Onbekende modus: ${mode}. Geldig: ${Object.keys(PROMPTS).join(', ')}` }, 400, corsHeaders);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker mist ANTHROPIC_API_KEY secret' }, 500, corsHeaders);
    }

    // Bonnen: eerst controleren wat er binnenkomt, vóórdat er iets naar de API gaat.
    let bonContent = null;
    if (mode === 'bon') {
      const check = buildBonContent(body.files);
      if (check.error) return json({ error: check.error }, 400, corsHeaders);
      bonContent = check.content;
    }

    // Bouw de user prompt op uit wat de PWA stuurt
    const userPrompt = buildUserPrompt(mode, body);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    try {
      if (mode === 'combi') return json(await askCombi(client, userPrompt), 200, corsHeaders);
      if (mode === 'bon')   return json(await askBon(client, bonContent), 200, corsHeaders);
      if (mode === 'idee')  return json(await askIdee(client, userPrompt), 200, corsHeaders);

      const data = await client.messages.create({
        model: MODELS[mode],
        max_tokens: MAX_TOKENS,
        system: PROMPTS[mode],
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return json({ text, model: data.model, usage: data.usage }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        return json({ error: 'Even te veel verzoeken — probeer het zo opnieuw' }, 429, corsHeaders);
      }
      if (e instanceof Anthropic.APIError) {
        return json({ error: `Claude API ${e.status ?? ''}`.trim(), detail: String(e.message).slice(0, 500) }, 502, corsHeaders);
      }
      return json({ error: 'Aanroep faalde', detail: String(e).slice(0, 300) }, 502, corsHeaders);
    }
  },
};

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // geen 0/O/I/1 (verwarring)
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function buildUserPrompt(mode, body) {
  const { list = [], history = [], deals = [] } = body;
  const today = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

  if (mode === 'combi') {
    const lines = list.map(it => `- ${it.name}`).join('\n');
    return `Mijn boodschappenlijst:\n${lines || '(leeg)'}`;
  }
  if (mode === 'idee') {
    const { gekocht = [], eerder = [] } = body;
    const koop = gekocht.slice(0, 60).map(g => `- ${g.name}`).join('\n');
    const lijst = list.slice(0, 60).map(it => `- ${it.name}`).join('\n');
    const oud = eerder.slice(0, 20).map(t => `- ${t}`).join('\n');
    return `Vandaag is ${today}.\n\nKort geleden gekocht:\n${koop || '(niets bekend)'}`
      + `\n\nStaat al op de boodschappenlijst:\n${lijst || '(niets)'}`
      + `\n\nEerdere ideeën (niet herhalen):\n${oud || '(geen)'}`;
  }
  if (mode === 'recept' || mode === 'vergeten') {
    const lines = list.length
      ? list.map(it => `- ${it.name}${it.qty > 1 ? ` (${it.qty}×)` : ''}`).join('\n')
      : '(lijst is leeg)';
    return `Vandaag is ${today}.\n\nMijn boodschappenlijstje:\n${lines}`;
  }
  if (mode === 'weekmenu') {
    const top = history.slice(0, 30).map(h => `${h.name} (${h.count}× gekocht)`).join(', ');
    return `Vandaag is ${today}.\n\nMijn 30 meest gekochte producten (uit ~3 maanden historie):\n${top || '(geen historie)'}`;
  }
  if (mode === 'deals') {
    const lines = deals.length
      // De app stuurt price_now/price_was; hier stond d.price, waardoor er nooit
      // een prijs bij het model aankwam.
      ? deals.slice(0, 40).map(d => {
          const nu = typeof d.price_now === 'number' ? d.price_now : d.price;
          const was = typeof d.price_was === 'number' && d.price_was > nu ? ` i.p.v. €${d.price_was.toFixed(2)}` : '';
          return `- ${d.name} bij ${d.store}: ${d.mechanism}${typeof nu === 'number' ? ` (€${nu.toFixed(2)}${was})` : ''}`;
        }).join('\n')
      : '(geen actieve aanbiedingen)';
    return `Vandaag is ${today}.\n\nActieve aanbiedingen deze week:\n${lines}`;
  }
  return '';
}

// Combi-suggesties: gestructureerde uitvoer, en bij een weigering de server-side
// terugval naar het model dat Anthropic per weigeringscategorie aanraadt.
// Een weigering die toch overblijft levert gewoon geen suggesties op; dat is
// voor deze functie een prima uitkomst.
export async function askCombi(client, userPrompt) {
  const data = await client.beta.messages.create({
    model: COMBI_MODEL,
    max_tokens: COMBI_MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: COMBI_SCHEMA },
    },
    system: PROMPTS.combi,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (data.stop_reason === 'refusal') {
    return { suggesties: [], model: data.model, usage: data.usage, geweigerd: true };
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Antwoord afgekapt (max_tokens)');
  }
  const text = data.content.find(b => b.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text);
  const suggesties = (parsed.suggesties || [])
    .filter(s => s && typeof s.naam === 'string' && s.naam.trim())
    .slice(0, 4)
    .map(s => ({ naam: s.naam.trim(), reden: String(s.reden || '').trim() }));
  return { suggesties, model: data.model, usage: data.usage };
}

// Zet de bestanden van de app om naar inhoudsblokken: afbeeldingen als image,
// PDF's als document, en daarna de vraag. Alles wat niet klopt wordt geweigerd
// in plaats van stilzwijgend overgeslagen, zodat de app het kan melden.
export function buildBonContent(files) {
  if (!Array.isArray(files) || !files.length) return { error: 'Geen bon meegestuurd' };
  if (files.length > BON_MAX_FILES) return { error: `Hooguit ${BON_MAX_FILES} bonnen per keer` };
  let totaal = 0;
  const content = [];
  for (const f of files) {
    if (!f || typeof f.data !== 'string' || !BON_TYPES.includes(f.type)) {
      return { error: 'Alleen een schermafbeelding (JPG, PNG, WebP) of PDF van een bon' };
    }
    totaal += f.data.length;
    if (totaal > BON_MAX_BASE64) return { error: 'De bonnen zijn samen te groot — laad er minder tegelijk in' };
    content.push(f.type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: f.type, data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } });
  }
  content.push({ type: 'text', text: files.length === 1
    ? 'Dit is mijn kassabon. Welke producten heb ik gekocht?'
    : `Dit zijn ${files.length} bestanden met kassabonnen. Welke producten heb ik gekocht?` });
  return { content };
}

// Eén aanroep met gestructureerde uitvoer, gedeeld door bon en idee. Zelfde
// opzet als askCombi: terugval bij een weigering, en een afgekapt antwoord is
// een fout in plaats van half-geparste JSON.
async function askStructured(client, { system, content, schema, maxTokens }) {
  const data = await client.beta.messages.create({
    model: COMBI_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema },
    },
    system,
    messages: [{ role: 'user', content }],
  });
  if (data.stop_reason === 'refusal') return { geweigerd: true, data };
  if (data.stop_reason === 'max_tokens') throw new Error('Antwoord afgekapt (max_tokens)');
  const text = data.content.find(b => b.type === 'text')?.text ?? '';
  return { parsed: JSON.parse(text), data };
}

export async function askBon(client, content) {
  const r = await askStructured(client, { system: PROMPTS.bon, content, schema: BON_SCHEMA, maxTokens: BON_MAX_TOKENS });
  if (r.geweigerd) return { bonnen: [], model: r.data.model, usage: r.data.usage, geweigerd: true };
  const bonnen = (r.parsed.bonnen || []).map(b => ({
    winkel: String(b.winkel || '').trim(),
    datum: /^\d{4}-\d{2}-\d{2}$/.test(b.datum || '') ? b.datum : '',
    producten: (b.producten || [])
      .filter(x => x && typeof x.naam === 'string' && x.naam.trim())
      .map(x => ({ naam: x.naam.trim(), aantal: Math.max(1, Math.min(99, Math.round(Number(x.aantal) || 1))) })),
  })).filter(b => b.producten.length);
  return { bonnen, model: r.data.model, usage: r.data.usage };
}

export async function askIdee(client, userPrompt) {
  const r = await askStructured(client, { system: PROMPTS.idee, content: userPrompt, schema: IDEE_SCHEMA, maxTokens: IDEE_MAX_TOKENS });
  if (r.geweigerd) return { ideeen: [], model: r.data.model, usage: r.data.usage, geweigerd: true };
  const ideeen = (r.parsed.ideeen || [])
    .filter(i => i && typeof i.titel === 'string' && i.titel.trim())
    .slice(0, 3)
    .map(i => ({
      titel: i.titel.trim(),
      bij: String(i.bij || '').trim(),
      uitleg: String(i.uitleg || '').trim(),
      nodig: (i.nodig || []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()).slice(0, 5),
    }));
  return { ideeen, model: r.data.model, usage: r.data.usage };
}

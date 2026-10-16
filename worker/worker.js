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

// 4 modi met elk hun eigen system prompt. Houd elke prompt kort en concreet —
// gebruiker wil snel iets bruikbaars zien, niet een essay.
const PROMPTS = {
  combi: `Je helpt iemand die een boodschappenlijst maakt. Kijk welke producten samen een gerecht of combinatie vormen, en welk product daarvoor nog ontbreekt.

Geef maximaal 4 suggesties. Per suggestie:
- naam: het product zoals je het op een boodschappenlijst schrijft, kort en algemeen (bijv. "rundergehakt", "parmezaanse kaas", "tortilla wraps") — geen merknaam, geen hoeveelheid
- reden: waarvoor, in een paar woorden (bijv. "voor spaghetti bolognese")

Stel geen producten voor die al op de lijst staan, ook niet in een andere vorm. Alleen suggesties die duidelijk volgen uit wat er al staat — liever geen suggestie dan een gok. Is er geen duidelijke combinatie, geef dan een lege lijst.`,
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
      return json({ ok: true, models: { ...MODELS, combi: COMBI_MODEL } }, 200, corsHeaders);
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

    // Bouw de user prompt op uit wat de PWA stuurt
    const userPrompt = buildUserPrompt(mode, body);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    try {
      if (mode === 'combi') return json(await askCombi(client, userPrompt), 200, corsHeaders);

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

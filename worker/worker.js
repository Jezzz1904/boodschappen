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

const ALLOWED_ORIGINS = [
  'https://boodschappen.herogames.nl',
  'http://boodschappen.herogames.nl',
  'http://localhost:5180',  // lokale dev
];

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1500;

// 4 modi met elk hun eigen system prompt. Houd elke prompt kort en concreet —
// gebruiker wil snel iets bruikbaars zien, niet een essay.
const PROMPTS = {
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
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
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
      return json({ ok: true, model: MODEL }, 200, corsHeaders);
    }
    if (!PROMPTS[mode]) {
      return json({ error: `Onbekende modus: ${mode}. Geldig: ${Object.keys(PROMPTS).join(', ')}` }, 400, corsHeaders);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker mist ANTHROPIC_API_KEY secret' }, 500, corsHeaders);
    }

    // Bouw de user prompt op uit wat de PWA stuurt
    const userPrompt = buildUserPrompt(mode, body);

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: PROMPTS[mode],
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return json({ error: `Claude API ${resp.status}`, detail: errText.slice(0, 500) }, 502, corsHeaders);
      }
      const data = await resp.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      return json({ text, model: data.model, usage: data.usage }, 200, corsHeaders);
    } catch (e) {
      return json({ error: 'Fetch faalde', detail: String(e).slice(0, 300) }, 502, corsHeaders);
    }
  },
};

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function buildUserPrompt(mode, body) {
  const { list = [], history = [], deals = [] } = body;
  const today = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

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
      ? deals.slice(0, 40).map(d => `- ${d.name} bij ${d.store}: ${d.mechanism}${d.price ? ` (€${d.price.toFixed(2)})` : ''}`).join('\n')
      : '(geen actieve aanbiedingen)';
    return `Vandaag is ${today}.\n\nActieve aanbiedingen deze week:\n${lines}`;
  }
  return '';
}

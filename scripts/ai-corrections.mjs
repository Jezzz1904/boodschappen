/**
 * Boodschappenheld – AI-correcties
 *
 * Haalt foutmeldingen op van de Share Worker, vraagt Claude om
 * data/corrections.json bij te werken, en committeert het resultaat.
 *
 * Benodigde env-variabelen (GitHub Secrets):
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   SHARE_WORKER_URL    — bijv. https://boodschappen-share.jerome-67a.workers.dev
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';

const WORKER_URL  = process.env.SHARE_WORKER_URL;
const API_KEY     = process.env.ANTHROPIC_API_KEY;
const CORRECTIONS = './data/corrections.json';

if (!WORKER_URL) { console.error('SHARE_WORKER_URL niet ingesteld'); process.exit(1); }
if (!API_KEY)    { console.error('ANTHROPIC_API_KEY niet ingesteld'); process.exit(1); }

// Haal rapporten op
const reportsRes = await fetch(`${WORKER_URL}/reports`);
if (!reportsRes.ok) { console.error('Ophalen rapporten mislukt:', reportsRes.status); process.exit(1); }
const reports = await reportsRes.json();

if (!reports.length) {
  console.log('Geen nieuwe rapporten gevonden.');
  process.exit(0);
}

console.log(`${reports.length} rapport(en) gevonden.`);

// Huidige correcties inlezen
const current = JSON.parse(readFileSync(CORRECTIONS, 'utf8'));

// Claude vragen om de correcties bij te werken
const client = new Anthropic({ apiKey: API_KEY });

const prompt = `Je bent een assistent voor de Boodschappenheld-app, een Nederlandse boodschappen-prijsvergelijker.

Gebruikers kunnen een 🚩 vlaggetje aanklikken als een productmatch fout is. Hieronder staan de ontvangen meldingen en de huidige correcties.

## Huidige corrections.json
${JSON.stringify(current, null, 2)}

## Nieuwe foutmeldingen van gebruikers
${JSON.stringify(reports, null, 2)}

## Jouw taak
Analyseer de meldingen en update de corrections.json. De structuur:
- "blacklist": object waarbij de sleutel de genormaliseerde zoekterm is (lowercase, zonder accenten), en de waarde een array van productnamenn die geblokkeerd moeten worden voor die zoekterm.

Normaliseer zoektermen: verwijder accenten, alles lowercase, extra spaties weg.

Groepeer meerdere meldingen voor hetzelfde product/zoekterm samen.
Voeg alleen toe wat echt verkeerd lijkt op basis van de meldingen.
Verwijder niets wat al in de blacklist staat.

Geef ALLEEN de volledige bijgewerkte JSON terug, geen uitleg, geen markdown-codeblok, puur JSON.`;

const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 2048,
  messages: [{ role: 'user', content: prompt }],
});

const raw = response.content[0].text.trim();

let updated;
try {
  updated = JSON.parse(raw);
} catch (e) {
  console.error('Claude gaf geen geldige JSON terug:', raw);
  process.exit(1);
}

// Zet metadata
updated.generatedAt = new Date().toISOString();
updated.reportCount  = reports.length;

writeFileSync(CORRECTIONS, JSON.stringify(updated, null, 2) + '\n', 'utf8');
console.log('corrections.json bijgewerkt:', JSON.stringify(updated.blacklist, null, 2));

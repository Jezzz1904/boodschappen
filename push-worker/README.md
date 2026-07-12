# Boodschappenheld – Push Worker

Cloudflare Worker die dagelijks je gevolgde producten checkt en een
pushmelding stuurt als de prijs daalt of er een bonus start.

**Let op:** dit checkt alleen de gescrapete winkels (AH, Jumbo, Plus, Lidl).
Handmatige prijzen (Kruidvat/Etos) staan alleen lokaal op je telefoon, dus
die kan de worker niet zien.

## Eenmalige setup (±10 minuten)

### 1. Installeer Wrangler (als je dat nog niet hebt)
```bash
npm install -g wrangler
wrangler login
```

### 2. Maak een KV namespace aan
```bash
cd push-worker
wrangler kv:namespace create PUSH_SUBS
```
Kopieer de `id` die je terugkrijgt en vul die in bij `id` in `wrangler.toml`.

### 3. Genereer een VAPID-sleutelpaar
VAPID-sleutels identificeren jouw worker bij de pushdiensten van Google/Mozilla/Apple.
```bash
npm install web-push
node generate-vapid-keys.mjs
```
Dit print drie waarden. Zet ze als secrets:
```bash
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```
(plak bij elke prompt de bijbehorende waarde)

### 4. Deploy
```bash
wrangler deploy
```
Je krijgt een URL zoals `https://boodschappen-push.xxx.workers.dev`.

### 5. Voer de URL in de app in
Open Boodschappenheld → ⚙️ Instellingen → "Push-meldingen" → plak de Worker URL
en zet meldingen aan. Je browser vraagt om toestemming voor notificaties.

## Testen zonder een dag te wachten

De cron draait dagelijks om 07:00 UTC. Om direct te testen kun je de check
handmatig triggeren (niet gelinkt vanuit de app, alleen voor jezelf):
```
https://boodschappen-push.xxx.workers.dev/run-check
```
Dit stuurt meteen meldingen naar alle abonnees met een actieve prijsalert.

## Hoe het werkt

- De app abonneert het device via de browser Push API en stuurt de
  gevolgde producten (`watchlist`) mee naar `/subscribe`.
- Bij elke wijziging van je gevolgde producten synct de app naar `/sync-watchlist`.
- De cron-trigger haalt dagelijks de actuele prijsdata op (dezelfde
  `data/*.json` bestanden als de app zelf gebruikt) en vergelijkt die
  tegen de prijs op het moment dat je begon te volgen.
- Bij een prijsdaling, actieve bonus, of "laagste in 30 dagen" krijg je
  een pushmelding, ook als de app niet open staat.

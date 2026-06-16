# Boodschappenheld – Deellijst Worker

Cloudflare Worker voor het live delen van boodschappenlijsten.

## Eenmalige setup (±5 minuten)

### 1. Installeer Wrangler (als je dat nog niet hebt)
```bash
npm install -g wrangler
wrangler login
```

### 2. Maak een KV namespace aan
```bash
cd share-worker
wrangler kv:namespace create SHARES
```
Kopieer de `id` die je terugkrijgt.

### 3. Vul de namespace ID in `wrangler.toml`
Vervang `VERVANG_MET_JE_KV_NAMESPACE_ID` met de ID die je in stap 2 hebt gekregen.

### 4. Deploy
```bash
wrangler deploy
```

Je krijgt een URL zoals `https://boodschappen-share.xxx.workers.dev`.

### 5. Voer de URL in de app in
Open de Boodschappenheld app → Tips-tab → scroll naar beneden → plak de Worker URL bij "Deellijst Worker".

## Gebruik

- Druk op **📤** in de actiebalk om een lijst te delen
- De link wordt gekopieerd / gedeeld via het telefoonmenu  
- De ontvanger opent de link en ziet de lijst automatisch synchroniseren
- Lijsten verlopen automatisch na 30 dagen

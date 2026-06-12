# Scrapers

Lichte Node.js scrapers die supermarkt prijzen + aanbiedingen ophalen. Output landt in `../data/*.json` en wordt door de PWA gelezen.

## Lokaal draaien

```bash
node scraper/run.mjs
```

Geen `npm install` nodig — alles gebruikt Node 20+ built-ins (`fetch`).

## Welke winkels

| Winkel | Status | Methode |
|---|---|---|
| Albert Heijn | ✓ | Mobile API + anonieme token |
| Jumbo | todo | |
| Plus | todo | |
| Lidl | todo | |
| Kruidvat | todo | |
| Etos | todo | |

## Zoeklijst

Standaard zoeklijst staat in `run.mjs` (`DEFAULT_QUERIES`). Override door een `data/queries.json` met een array van strings te zetten — bv. de "vaak gekocht" uit de PWA.

## Cron

Draait dagelijks via `.github/workflows/scrape.yml` (~05:15 NL). Commit verse `data/*.json` als er wijzigingen zijn.

## Etiquette

- Eén zoekquery per product, geen massaverzoeken
- 250 ms pauze tussen calls
- Alleen voor persoonlijk gebruik — niet redistribueren

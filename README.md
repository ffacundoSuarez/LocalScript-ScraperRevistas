# ScraperRevistas — PoC

Lee una **revista PDF** de promos de un supermercado con **GPT-4 Vision**, extrae los productos, los
**matchea contra el catálogo** existente (endpoint) con un nivel de confianza, y arma una **cola de
revisión humana** con una UI local donde una persona ve la página y **acepta/rechaza** cada match.

**Supers soportados:** Makro, Vital, Rosental, Comodín. Cada uno publica distinto (PDFs directos o
flipbooks). Ver [docs/INGESTA-SUPERS.md](docs/INGESTA-SUPERS.md) para el detalle de cada estrategia.

## Setup

```bash
npm install
cp .env.example .env   # y completá OPENAI_API_KEY y PRODUCTS_API_KEY

# Sólo si vas a usar Comodín (flipbook Publuu): instala el navegador headless
npx playwright install chromium
```

(El PDF también podés dejarlo a mano en `data/pdfs/` y procesar un archivo local; ver más abajo.)

## Uso

> ⚠️ Para los comandos con flags (`--super`, `--pages`) usá **`npx tsx` directo**: npm se come los
> `--flags` al reenviarlos, así que `npm run ... -- --super=x` NO funciona bien.

```bash
# 1) Traer el catálogo y ver el esquema real de un producto
npm run products

# 2) Descargar + procesar las revistas del super automáticamente (desde su URL de ofertas)
npx tsx src/run.ts --super=makro --from-url

#    Prueba barata (primeras N páginas por PDF):
npx tsx src/run.ts --super=makro --from-url --pages=2

#    (Alternativa) procesar un PDF local suelto:
npx tsx src/run.ts data/pdfs/makro.pdf --super=makro

# 3) Levantar la UI de revisión y abrir http://localhost:3000
npx tsx src/review-server.ts --super=makro
```

### Sólo descargar (sin procesar)
```bash
npx tsx src/download.ts --super=makro   # baja los PDFs a data/pdfs/makro/
```

### Re-match barato (iterar el juez sin re-pagar visión)
```bash
npx tsx src/rematch.ts --super=makro    # re-corre el matching desde all.json
```

Cada corrida del paso 2 deja en `data/output/<super>/`:
- `pages/page-XX.png` — las páginas renderizadas (las usa la UI).
- `review.json` — la **cola**: matches propuestos con estado `pending/accepted/rejected`.
- `all.json` — dump completo de todo lo extraído (debug).

## Flags útiles (paso 2)
- `--super=nombre` → nombre del super (define la carpeta de salida). Default: nombre del PDF.
- `--pages=N` → procesa sólo las primeras N páginas (controlar costo en pruebas).
- `--refresh` → vuelve a pegarle al endpoint en vez de usar el catálogo cacheado.

## Variables de entorno (`.env`)
- `OPENAI_API_KEY`, `PRODUCTS_API_KEY` (requeridas).
- `MATCH_THRESHOLD` (default `0.3`) → confianza mínima para mandar un match a la cola. Más bajo = más
  candidatos dudosos para el humano; más alto = cola más chica.
- `VISION_MODEL` (default `gpt-4o`), `JUDGE_MODEL` (default `gpt-4o-mini`).

## Estructura
- `src/supermarkets.ts` — config por super (URL de ofertas + estrategia de descarga).
- `src/download.ts` — encuentra y descarga los PDFs de la página de ofertas del super.
- `src/products.ts` — trae y cachea el catálogo (paginación por `page`).
- `src/render.ts` — PDF → imágenes (pdf-to-img, sin canvas nativo → anda en Windows).
- `src/extract.ts` — imagen → productos estructurados (GPT-4 Vision).
- `src/match.ts` — EAN exacto → embeddings top-K → filtro de marca → juez LLM (candidato + confianza).
- `src/store.ts` — guarda PNGs (por revista) + cola de revisión acumulativa (`review.json`).
- `src/run.ts` — orquesta: descarga (`--from-url`) → render → extracción → match.
- `src/rematch.ts` — re-corre sólo el matching desde `all.json` (barato).
- `src/review-server.ts` + `public/review/` — UI local de revisión (Aceptar/Rechazar).
```

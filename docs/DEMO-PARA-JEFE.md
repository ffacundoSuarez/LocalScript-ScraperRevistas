# ScraperRevistas — Lectura de promos en revistas de supermercado con IA

> Documento de presentación. Explica **qué resuelve** el sistema, **cómo funciona de punta a punta**
> y **qué esperar** al verlo correr. Pensado para leerse sin abrir el código.

---

## 1. El problema

El equipo scrapea ~40 supermercados para mantener precios y promociones. La mayoría se scrapea por
**URL de producto** (HTML normal). Pero **algunos supers no publican las promos en la web**: las
publican sólo en una **revista/folleto** (un PDF o un "flipbook" online). Eso **no se puede scrapear
como HTML** — los precios y productos están dentro de imágenes.

Hoy esos supers quedan afuera o se cargan a mano. **ScraperRevistas cierra ese hueco**: lee la
revista con IA, extrae los productos con sus precios y los **matchea contra el catálogo existente**,
dejando una **cola de revisión humana** para aprobar o rechazar cada match antes de que entre al
sistema.

---

## 2. El flujo de punta a punta

```
 URL del super
      │
      ▼
 [1] Descarga          → baja el PDF o las imágenes de cada página de la revista
      │
      ▼
 [2] Extracción (IA)   → GPT-4 Vision "lee" cada página y devuelve los productos
      │                   (nombre, marca, precio, promo, cantidad, EAN)
      ▼
 [3] Match (IA)        → cada producto de la revista se compara contra el catálogo
      │                   y se propone el producto del catálogo que le corresponde
      ▼
 [4] Cola de revisión  → UI web: una persona ve la página + el match propuesto
                          y aprueba (A) o rechaza (R)
```

Todo lo automático (pasos 1–3) corre con **un solo comando** por super. El paso 4 es una **interfaz
web** simple pensada para revisar rápido (atajos de teclado).

---

## 3. Cómo se obtiene la revista de cada super (paso 1)

Cada super publica distinto, así que hay una **estrategia por super**. Todas terminan produciendo lo
mismo: las imágenes de cada página, listas para que la IA las lea.

| Super | Cómo publica | Cómo lo resolvemos | Navegador |
|---|---|---|---|
| **Makro** | PDFs en su web | Se bajan los PDF directos del CDN | No |
| **Vital** | PDFs por sucursal | Se filtran los folletos mostrados (1 localidad) | No |
| **Rosental** | Flipbook PubHTML5 | Se leen las imágenes del visor (148 páginas) | No |
| **Comodín** | Flipbook Publuu | Se descubre el patrón de imágenes y se bajan | Sí (mínimo) |

> Los flipbooks (Rosental/Comodín) **rotan sus URLs cada período**, por eso el sistema las
> **re-descubre en cada corrida** en vez de tenerlas fijas. Detalle técnico completo en
> [`INGESTA-SUPERS.md`](./INGESTA-SUPERS.md).

---

## 4. Cómo lee la revista (paso 2 — extracción)

Cada página se manda a **GPT-4 Vision** con un esquema estricto (structured outputs). El modelo
devuelve, por cada producto visible:

`nombre · marca · precio · precio de promo · texto de la promo · cantidad · EAN`

Ignora adornos, logos y "letra chica" legal. Resultado: una lista limpia de productos por página.

---

## 5. Cómo matchea contra el catálogo (paso 3)

El match es el corazón del sistema y usa **dos etapas + un filtro determinístico** para evitar falsos
positivos:

1. **EAN exacto** — si el producto de la revista tiene código de barras y coincide con el catálogo,
   match directo con 100% de confianza.
2. **Búsqueda semántica** — si no hay EAN, se buscan los productos del catálogo más parecidos por
   significado (embeddings), no sólo por texto literal.
3. **Filtro de marca** — antes de decidir, se descartan los candidatos de otra marca. La marca es el
   mejor discriminador y esto elimina errores tipo "AYUDÍN ≠ otra lavandina" de forma segura.
4. **Juez (IA)** — un segundo modelo decide si es **el mismo producto** (misma variante/tipo),
   tolerando diferencias de tamaño (500 vs 510 ml). Puede responder **"no es ninguno"**, que es una
   respuesta **correcta y frecuente** (ver abajo).

Cada match queda con un **nivel de confianza** que la UI muestra como barra de color.

---

## 6. La interfaz de revisión (paso 4)

Una web local (`http://localhost:3000`) que muestra, item por item:

- A la izquierda, la **imagen de la página** de la revista.
- A la derecha, el **producto extraído**, el **match propuesto del catálogo**, la **confianza** y una
  **justificación** del juez.
- Botones **Aceptar** / **Rechazar** (atajos de teclado **A** y **R**).
- Un **selector arriba** para cambiar entre supermercados sin reiniciar nada.

Cada decisión se guarda al instante. Es deliberadamente simple: el objetivo es revisar muchos matches
rápido.

---

## 7. Qué esperar al verlo (casos de éxito)

- ✅ **Ingesta:** los 4 supers descargan y procesan solos (los flipbooks se re-descubren en vivo).
- ✅ **Extracción:** la IA lee bien las páginas y devuelve productos coherentes con precio/promo.
- ✅ **Match positivo:** productos de limpieza presentes en el catálogo se matchean bien (ej.
  Procenex→Procenex, Cif Antigrasa→Cif Antigrasa, Lysoform→Lysoform); cuando hay EAN, es exacto.
- ✅ **"No match" correcto:** muchos productos de la revista dan *"no es ninguno"* — **y eso está
  bien**. Ver la nota importante:

> **El nivel de confianza es una guía, no una garantía.** Por diseño, el sistema **propone** y la
> persona **confirma**. Aún en matches de alta confianza pueden colarse **falsos positivos** (ej. una
> marca cuyo nombre es parte de otra, o un producto sin marca legible). El paso de revisión humana
> existe justamente para descartarlos en segundos — **no es un parche, es parte del diseño**.

> **⚠️ Nota sobre el catálogo de esta prueba.** El catálogo que devuelve el endpoint actual son
> **768 productos, todos de limpieza** (lavandinas, desinfectantes, aromatizadores, insecticidas).
> Las revistas mayoristas traen **de todo** (alimentos, bebidas, electro, etc.). Por lo tanto, **la
> mayoría de los productos de la revista correctamente dan "no match"**: no están en este catálogo.
> Eso **no es un error**, es el alcance del catálogo. Los matches reales aparecen en las **secciones
> de limpieza** de cada revista. Queda por confirmar si la API key está acotada por categoría y el
> catálogo completo es más grande (ver Próximos pasos).

---

## 8. Resultados de la corrida de demo

Corrida de junio (2ª quincena), procesando una porción de cada revista para controlar costo de IA:

| Super | Páginas leídas | Productos extraídos | Matches en cola |
|---|---|---|---|
| Makro | 57 (5 folletos) | 593 | 8 |
| Vital | 30 (6 folletos) | 286 | 5 |
| Rosental | 88 (61–148, de 148) | 1.375 | 58 |
| Comodín | 23 | 271 | 14 |
| **Total** | **198** | **2.525** | **85** |

Sobre ~2.500 productos leídos de las revistas, **85** matchearon contra el catálogo de limpieza y
quedaron para revisión humana. El resto dio "no match" — en su gran mayoría correctamente, porque
son productos fuera del catálogo de limpieza (alimentos, bebidas, etc.). Ver la nota de la sección 7.

> En Rosental se leyó la **2ª mitad** de la revista (páginas 61–148): ahí está el grueso de la
> sección de limpieza, por eso da más matches (58) que la 1ª mitad (33). Es un ejemplo de por qué
> conviene poder elegir el rango de páginas a procesar.

---

## 9. Estado y próximos pasos

**Funcionando hoy:** descarga automática de los 4 supers · extracción con visión · match de 2 etapas
· UI de revisión con aprobar/rechazar y selector de super.

**Robustez y velocidad (mejoras recientes):**
- **Reintentos automáticos:** ante un error de red o saturación temporal del servicio de IA, el
  sistema reintenta solo en vez de abortar toda la corrida.
- **Reanudación sin re-pagar IA:** la lectura de cada página se va guardando a medida que sale; si
  una corrida se corta, la siguiente retoma donde quedó y **no vuelve a pagar** lo ya leído.
- **Procesamiento en paralelo:** lectura y match corren de a varios a la vez. En la prueba de
  Rosental, el match de ~1.375 productos bajó de ~15–20 min a ~2 min.
- **Selección de páginas:** se puede pedir un rango (ej. páginas 61–148) para leer justo la sección
  de interés y controlar el costo de IA.

**Próximos pasos:**
- **Confirmar el catálogo real:** verificar si el endpoint está acotado a limpieza o si hay un
  catálogo completo (cambiaría drásticamente la cantidad de matches).
- **Persistencia en Supabase:** hoy las decisiones se guardan en archivos locales; el paso siguiente
  es base de datos.
- **Export de aprobados** para alimentar el sistema principal.
- **Ejecución programada (cron)** para que corra solo cada período.

---

## 10. Cómo correrlo

Requisitos: Node.js, y un archivo `.env` con `OPENAI_API_KEY` y `PRODUCTS_API_KEY`.

```bash
# 1) Descargar + leer + matchear un super (--pages limita el costo de IA)
npx tsx src/run.ts --super=<makro|vital|rosental|comodin> --from-url --pages=20
#    …o un rango de páginas (útil para caer en la sección de limpieza):
npx tsx src/run.ts --super=rosental --from-url --pages=61-148

# 2) Abrir la UI de revisión (sirve TODOS los supers que ya se corrieron)
npx tsx src/review-server.ts
#    → http://localhost:3000  (elegir el super en el selector de arriba)

# Iterar el match sin volver a pagar visión (re-usa lo ya extraído):
npx tsx src/rematch.ts --super=<nombre>
```

> El costo de IA está en la **lectura de páginas** (visión). Para la demo conviene **pre-generar** los
> datos y mostrar la UI sobre lo ya procesado, en vez de correr visión en vivo.

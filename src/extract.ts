import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { config } from './config.js';
import { detectImage } from './image.js';
import { withRetry } from './retry.js';

const client = new OpenAI({ apiKey: config.openaiApiKey });

// Schema de salida estructurada. Structured outputs de OpenAI no admite .optional(),
// por eso usamos .nullable() en todo lo que puede no estar.
const ExtractedProduct = z.object({
  name: z.string().describe('Nombre del producto tal como aparece en la revista'),
  brand: z.string().nullable().describe('Marca, si se ve'),
  ean: z.string().nullable().describe('Código de barras EAN/GTIN si aparece impreso'),
  price: z.number().nullable().describe('Precio normal/regular en número, sin símbolos'),
  promo_price: z.number().nullable().describe('Precio promocional/oferta si lo hay'),
  promo_text: z.string().nullable().describe('Texto de la promo (ej. "2x1", "30% off", "Lleva 3 paga 2")'),
  quantity: z.string().nullable().describe('Cantidad/contenido (ej. "1L", "500g", "x6")'),
  confidence: z.number().describe('Qué tan seguro estás de haber leído bien este item (0 a 1)'),
});

const PageExtraction = z.object({
  products: z.array(ExtractedProduct),
});

export type ExtractedProduct = z.infer<typeof ExtractedProduct>;

const SYSTEM_PROMPT = `Sos un asistente experto en leer revistas de promociones de supermercados.
Recibís la imagen de UNA página y extraés ÚNICAMENTE los productos reales que están a la venta con su precio o promoción.

Reglas:
- Extraé un item por cada producto distinto que veas con su precio/oferta.
- Ignorá decoración, logos, banners institucionales, textos legales, condiciones, horarios y cualquier cosa que no sea un producto a la venta.
- Si un dato no está visible, devolvé null (no lo inventes).
- Precios como número, sin símbolo de moneda ni separador de miles (ej. 1299.99).
- Si ves una promo (2x1, 30%, "lleva 3 paga 2", precio tachado), capturala en promo_text y/o promo_price.
- confidence refleja qué tan claro se leía el item.
- Si la página no tiene productos (tapa, índice, legales), devolvé products: [].`;

/** Extrae los productos de una página (imagen PNG/JPEG/WebP) usando GPT-4 Vision. */
export async function extractProductsFromPage(
  image: Buffer,
  pageNumber: number,
): Promise<ExtractedProduct[]> {
  const { mime } = detectImage(image);
  const base64 = image.toString('base64');

  const completion = await withRetry(
    () =>
      client.beta.chat.completions.parse({
        model: config.visionModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Página ${pageNumber}. Extraé los productos en promoción.` },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
              },
            ],
          },
        ],
        response_format: zodResponseFormat(PageExtraction, 'page_extraction'),
      }),
    { label: `visión pág. ${pageNumber}` },
  );

  return completion.choices[0]?.message.parsed?.products ?? [];
}

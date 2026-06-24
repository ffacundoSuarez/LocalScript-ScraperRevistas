import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Copiá .env.example a .env y completala.`,
    );
  }
  return value;
}

export const config = {
  openaiApiKey: required('OPENAI_API_KEY'),
  productsApiKey: required('PRODUCTS_API_KEY'),
  productsApiUrl:
    process.env.PRODUCTS_API_URL ?? 'https://api.meganalytics.net/v1/products',

  // Modelos (overrideables por env)
  visionModel: process.env.VISION_MODEL ?? 'gpt-4o',
  judgeModel: process.env.JUDGE_MODEL ?? 'gpt-4o-mini',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // Umbral mínimo de confianza para mandar un candidato a la cola de revisión humana.
  // Bajo a propósito: el humano es el filtro real; preferimos que dude un humano y no perder matches.
  matchThreshold: Number(process.env.MATCH_THRESHOLD ?? '0.3'),
} as const;

export type Strategy = 'html-pdf-links' | 'pubhtml5' | 'publuu';

export interface Supermarket {
  id: string;
  name: string;
  /** Cómo obtener las revistas. */
  strategy: Strategy;
  /** Página de ofertas (estrategia html-pdf-links). */
  offersUrl?: string;
  /** URL base del libro PubHTML5 (estrategia pubhtml5), con barra final. */
  pubhtml5Url?: string;
}

export const SUPERMARKETS: Record<string, Supermarket> = {
  makro: {
    id: 'makro',
    name: 'Makro',
    strategy: 'html-pdf-links',
    offersUrl: 'https://makro.com.ar/ofertas/',
  },
  vital: {
    id: 'vital',
    name: 'Vital',
    strategy: 'html-pdf-links',
    offersUrl: 'https://www.vital.com.ar/ofertas/', // muestra los folletos de Abasto (1 localidad)
  },
  rosental: {
    id: 'rosental',
    name: 'Rosental',
    strategy: 'pubhtml5',
    // La home linkea el flipbook PubHTML5 vigente en su HTML estático: lo descubrimos en cada
    // corrida desde acá (así no se rompe cuando publican uno nuevo).
    offersUrl: 'https://www.rosental.com.ar/',
    // Fallback por si algún día el link no aparece en la home.
    pubhtml5Url: 'https://online.pubhtml5.com/oggo/ignq/',
  },
  comodin: {
    id: 'comodin',
    name: 'Comodín',
    strategy: 'publuu',
    // Página de la que se descubre el flipbook Publuu vigente (cambia cada período).
    offersUrl: 'https://supermercadoscomodin.com/maxicomodin/',
  },
};

export function getSupermarket(id: string): Supermarket {
  const sm = SUPERMARKETS[id];
  if (!sm) {
    const known = Object.keys(SUPERMARKETS).join(', ') || '(ninguno configurado)';
    throw new Error(`Super "${id}" no configurado. Conocidos: ${known}`);
  }
  return sm;
}

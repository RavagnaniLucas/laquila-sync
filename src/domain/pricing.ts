export interface PricingRules {
  markup: number; // preço = custo × markup + custo fixo
  minMargin: number; // margem mínima sobre o preço de venda (0.25 = 25%)
  fixedCost: number; // custo fixo por pedido (taxa Laquila R$ 8)
  ending: number; // centavos finais, ex.: 0.9 → R$ xx,90
  mapBrands: string[]; // marcas com política de preço mínimo (Texx, HJC)
}

export interface PriceInput {
  cost: number; // vl_preco da Laquila
  suggested?: number; // vl_sugerido da Laquila
  brand?: string;
}

export interface PriceResult {
  price: number;
  compareAt?: number; // preço "de" opcional (o sugerido, quando maior)
  reason: 'markup' | 'min_margin' | 'map';
}

/**
 * Calcula o preço de venda. Retorna null quando o custo é inválido:
 * nesse caso o produto não deve ser publicado nem atualizado.
 */
export function computePrice(input: PriceInput, rules: PricingRules): PriceResult | null {
  const { cost } = input;
  if (!Number.isFinite(cost) || cost <= 0) return null;

  const byMarkup = cost * rules.markup + rules.fixedCost;
  const byMargin = (cost + rules.fixedCost) / (1 - rules.minMargin);
  let price = Math.max(byMarkup, byMargin);
  let reason: PriceResult['reason'] = byMarkup >= byMargin ? 'markup' : 'min_margin';

  const suggested = input.suggested && input.suggested > 0 ? input.suggested : undefined;
  if (suggested && isMapBrand(input.brand, rules.mapBrands) && price < suggested) {
    price = suggested;
    reason = 'map';
  }

  price = roundToEnding(price, rules.ending);

  // Política Texx/HJC: nunca abaixo do sugerido, nem depois do arredondamento.
  if (suggested && isMapBrand(input.brand, rules.mapBrands) && price < suggested) {
    price = roundToEnding(suggested, rules.ending);
  }

  const result: PriceResult = { price, reason };
  if (suggested && suggested > price) result.compareAt = round2(suggested);
  return result;
}

export function isMapBrand(brand: string | undefined, mapBrands: string[]): boolean {
  if (!brand) return false;
  const b = normalize(brand);
  return mapBrands.some((m) => b === normalize(m) || b.startsWith(normalize(m) + ' '));
}

/** Arredonda para cima até terminar nos centavos indicados (ex.: 0.9 → 57,90). */
export function roundToEnding(value: number, ending: number): number {
  if (ending <= 0) return round2(Math.ceil(value * 100) / 100);
  const whole = Math.floor(value);
  let candidate = whole + ending;
  if (candidate + 1e-9 < value) candidate += 1;
  return round2(candidate);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

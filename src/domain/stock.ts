export interface StockRules {
  safety: number; // abaixo ou igual a isso, mostra 0
  maxShown: number; // teto exibido na loja
}

/**
 * Quantidade a exibir na loja a partir do saldo da Laquila.
 * O estoque da Laquila é compartilhado com outros lojistas, então
 * guardamos uma margem e não mostramos o saldo inteiro.
 */
export function shownStock(laquilaQty: number, rules: StockRules, maxPerOrder?: number): number {
  if (!Number.isFinite(laquilaQty) || laquilaQty <= rules.safety) return 0;
  let qty = Math.floor(laquilaQty - rules.safety);
  qty = Math.min(qty, rules.maxShown);
  if (maxPerOrder && maxPerOrder > 0) qty = Math.min(qty, maxPerOrder);
  return Math.max(0, qty);
}

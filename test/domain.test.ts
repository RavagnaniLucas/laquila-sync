import { describe, expect, it } from 'vitest';
import { computePrice, isMapBrand, roundToEnding, type PricingRules } from '../src/domain/pricing.js';
import { shownStock } from '../src/domain/stock.js';

const rules: PricingRules = { markup: 1.8, minMargin: 0.25, fixedCost: 8, ending: 0.9, mapBrands: ['TEXX', 'HJC'] };

describe('computePrice', () => {
  it('aplica markup e custo fixo e arredonda para ,90', () => {
    // 30 × 1,8 + 8 = 62 → 62,90
    expect(computePrice({ cost: 30 }, rules)).toEqual({ price: 62.9, reason: 'markup' });
  });

  it('usa a margem mínima quando o markup é baixo', () => {
    const r = computePrice({ cost: 100 }, { ...rules, markup: 1.1 });
    // (100 + 8) / 0,75 = 144 → 144,90
    expect(r).toEqual({ price: 144.9, reason: 'min_margin' });
  });

  it('respeita o preço sugerido para Texx e HJC', () => {
    const r = computePrice({ cost: 100, suggested: 399.99, brand: 'Texx' }, rules);
    expect(r?.price).toBeGreaterThanOrEqual(399.99);
    expect(r?.reason).toBe('map');
  });

  it('não força o sugerido para outras marcas, mas guarda como preço "de"', () => {
    const r = computePrice({ cost: 30, suggested: 99, brand: 'Pro Tork' }, rules);
    expect(r).toEqual({ price: 62.9, reason: 'markup', compareAt: 99 });
  });

  it('não publica custo zero ou inválido', () => {
    expect(computePrice({ cost: 0 }, rules)).toBeNull();
    expect(computePrice({ cost: Number.NaN }, rules)).toBeNull();
  });
});

describe('helpers', () => {
  it('roundToEnding', () => {
    expect(roundToEnding(62, 0.9)).toBe(62.9);
    expect(roundToEnding(62.95, 0.9)).toBe(63.9);
    expect(roundToEnding(62.9, 0.9)).toBe(62.9);
  });
  it('isMapBrand ignora acento e caixa', () => {
    expect(isMapBrand('hjc', ['HJC'])).toBe(true);
    expect(isMapBrand('TEXX HIBRIDO', ['TEXX'])).toBe(true);
    expect(isMapBrand('TEXXON', ['TEXX'])).toBe(false);
  });
});

describe('shownStock', () => {
  const s = { safety: 2, maxShown: 50 };
  it('zera quando o saldo está na margem de segurança', () => {
    expect(shownStock(2, s)).toBe(0);
    expect(shownStock(0, s)).toBe(0);
  });
  it('desconta a margem e aplica teto e máximo por pedido', () => {
    expect(shownStock(10, s)).toBe(8);
    expect(shownStock(500, s)).toBe(50);
    expect(shownStock(10, s, 6)).toBe(6);
  });
});

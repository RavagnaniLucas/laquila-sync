import { config } from '../config.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { computePrice, type PricingRules } from '../domain/pricing.js';
import { shownStock } from '../domain/stock.js';
import { LaquilaClient, type LaquilaItemFilter } from '../clients/laquila.js';
import * as bling from '../clients/bling.js';
import * as shopify from '../clients/shopify.js';

export const pricingRules = (): PricingRules => ({
  markup: config.PRICE_MARKUP,
  minMargin: config.PRICE_MIN_MARGIN,
  fixedCost: config.PRICE_FIXED_COST,
  ending: config.PRICE_ENDING,
  mapBrands: config.MAP_BRANDS.split(',').map((s) => s.trim()).filter(Boolean),
});

const stockRules = () => ({ safety: config.STOCK_SAFETY, maxShown: config.STOCK_MAX_SHOWN });

async function run<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [r] = await sql<{ id: string }[]>`insert into sync_runs (job) values (${job}) returning id`;
  try {
    const stats = await fn();
    await sql`update sync_runs set finished_at = now(), ok = true, stats = ${sql.json((stats ?? {}) as any)} where id = ${r!.id}`;
    logger.info({ job, stats }, 'sincronização concluída');
    return stats;
  } catch (err) {
    await sql`update sync_runs set finished_at = now(), ok = false, error = ${String(err)} where id = ${r!.id}`;
    throw err;
  }
}

/**
 * Cadastro: lê os dados do 00007 (descrição, EAN, NCM, peso, medidas da caixa) e grava no banco.
 * Não publica nada; a publicação só acontece para produtos habilitados (publishCatalog).
 * Fotos e marca não vêm da API da Laquila: ficam para preencher por outra fonte.
 */
export function importItems(filter: LaquilaItemFilter = {}, laquila = new LaquilaClient()) {
  return run('items', async () => {
    let read = 0;
    let inactive = 0;
    for await (const page of laquila.items(filter)) {
      read += page.length;
      for (const it of page) {
        if (!it.active) inactive++;
        await sql`
          insert into products (sku, title, description_html, gtin, ncm, weight_kg, raw, brand, laquila_active)
          values (${it.sku}, ${it.title}, ${toHtml(it.description)}, ${it.gtin}, ${it.ncm},
                  ${it.weightGrossKg ?? it.weightNetKg}, ${sql.json(it.raw as any)}, ${filter.ds_marca ?? null}, ${it.active})
          on conflict (sku) do update set title = excluded.title, description_html = excluded.description_html,
            gtin = excluded.gtin, ncm = excluded.ncm, weight_kg = excluded.weight_kg, raw = excluded.raw,
            brand = coalesce(excluded.brand, products.brand), laquila_active = excluded.laquila_active, updated_at = now()`;
      }
    }
    return { read, inactive };
  });
}

function toHtml(text: string): string | null {
  if (!text) return null;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\r?\n+/).map((l) => `<p>${l.trim()}</p>`).join('');
}

/**
 * Estoque: lê o saldo da Laquila (00017), recalcula o que mostrar e envia só o que mudou
 * para Shopify e Bling. Só mexe em produtos habilitados e já publicados.
 */
export function syncStock(laquila = new LaquilaClient()) {
  return run('stock', async () => {
    let read = 0;
    const changed: Array<{ sku: string; shown: number; inventoryItemId: string | null; blingId: string | null }> = [];
    // 00017 é uma foto completa do saldo (limite de 3 consultas por hora).
    const page = await laquila.stock();
    read = page.length;
    {
      for (const it of page) {
        const [row] = await sql<{ shown_qty: number | null; enabled: boolean; shopify_inventory_item_id: string | null; bling_id: string | null; qty_max: number | null }[]>`
          insert into products (sku, laquila_cadastro, laquila_qty, qty_max)
          values (${it.sku}, ${it.cadastro}, ${it.qty}, ${it.qtyMax})
          on conflict (sku) do update set laquila_qty = excluded.laquila_qty, qty_max = excluded.qty_max, updated_at = now()
          returning shown_qty, enabled, shopify_inventory_item_id, bling_id, qty_max`;
        if (!row?.enabled) continue;
        const shown = shownStock(it.qty, stockRules(), row.qty_max ?? undefined);
        if (shown !== row.shown_qty) {
          changed.push({ sku: it.sku, shown, inventoryItemId: row.shopify_inventory_item_id, blingId: row.bling_id });
        }
      }
    }

    const toShopify = changed.filter((c) => c.inventoryItemId).map((c) => ({ inventoryItemId: c.inventoryItemId!, quantity: c.shown }));
    if (config.SHOPIFY_ENABLED && toShopify.length) await shopify.setQuantities(toShopify);
    if (config.BLING_ENABLED) {
      for (const c of changed.filter((c) => c.blingId)) await bling.setStock(Number(c.blingId), c.shown);
    }
    for (const c of changed) {
      await sql`update products set shown_qty = ${c.shown}, synced_stock_at = now() where sku = ${c.sku}`;
    }
    return { read, changed: changed.length };
  });
}

/** Preço: lê custo e sugerido (00018), recalcula e atualiza onde mudou. */
export function syncPrices(laquila = new LaquilaClient()) {
  return run('price', async () => {
    let read = 0;
    let changed = 0;
    let skipped = 0;
    const rules = pricingRules();
    for await (const page of laquila.prices()) {
      read += page.length;
      for (const it of page) {
        const [row] = await sql<{ brand: string | null; price: string | null; enabled: boolean; shopify_product_id: string | null; shopify_variant_id: string | null; bling_id: string | null }[]>`
          insert into products (sku, laquila_cadastro, cost, suggested, qty_min, qty_max)
          values (${it.sku}, ${it.cadastro}, ${it.cost}, ${it.suggested}, ${it.qtyMin}, ${it.qtyMax})
          on conflict (sku) do update set cost = excluded.cost, suggested = excluded.suggested,
            qty_min = excluded.qty_min, qty_max = excluded.qty_max, updated_at = now()
          returning brand, price, enabled, shopify_product_id, shopify_variant_id, bling_id`;
        const result = computePrice({ cost: it.cost, suggested: it.suggested, brand: row?.brand ?? undefined }, rules);
        if (!result) {
          skipped++;
          continue;
        }
        if (row && Number(row.price) === result.price) continue;
        await sql`update products set price = ${result.price}, compare_at = ${result.compareAt ?? null} where sku = ${it.sku}`;
        changed++;
        if (!row?.enabled) continue;
        if (config.SHOPIFY_ENABLED && row.shopify_product_id && row.shopify_variant_id) {
          await shopify.updatePrice(row.shopify_product_id, row.shopify_variant_id, result.price, result.compareAt);
        }
        if (config.BLING_ENABLED && row.bling_id) {
          await bling.bling('PATCH', `/produtos/${row.bling_id}`, { preco: result.price, precoCusto: it.cost });
        }
        await sql`update products set synced_price_at = now() where sku = ${it.sku}`;
      }
    }
    return { read, changed, skipped };
  });
}

/**
 * Publica (cria ou atualiza) os produtos habilitados no Bling e na Shopify.
 * Depende de título, fotos, NCM etc., que ainda não sabemos como obter da Laquila;
 * até lá, dá para preencher manualmente (CLI `produto:dados`) para o piloto.
 */
export function publishCatalog(onlySku?: string) {
  return run('publish', async () => {
    const rows = await sql<any[]>`
      select * from products where enabled and laquila_active and price is not null and title is not null
      ${onlySku ? sql`and sku = ${onlySku}` : sql``}`;
    let ok = 0;
    const failed: string[] = [];
    for (const p of rows) {
      try {
        const images = (p.images as string[]) ?? [];
        if (config.BLING_ENABLED) {
          const blingId = await bling.upsertProduct(
            {
              sku: p.sku, nome: p.title, preco: Number(p.price), precoCusto: Number(p.cost), marca: p.brand ?? undefined,
              ncm: p.ncm ?? undefined, gtin: p.gtin ?? undefined, pesoKg: p.weight_kg ? Number(p.weight_kg) : undefined,
              descricaoHtml: p.description_html ?? undefined, imagens: images,
            },
            p.bling_id ? Number(p.bling_id) : null,
          );
          await sql`update products set bling_id = ${blingId} where sku = ${p.sku}`;
        }
        if (config.SHOPIFY_ENABLED) {
          const shown = shownStock(p.laquila_qty ?? 0, stockRules(), p.qty_max ?? undefined);
          const ids = await shopify.upsertProduct({
            sku: p.sku, title: p.title, descriptionHtml: p.description_html ?? undefined, vendor: p.brand ?? undefined,
            productType: p.category ?? undefined, price: Number(p.price), compareAt: p.compare_at ? Number(p.compare_at) : undefined,
            cost: p.cost ? Number(p.cost) : undefined, barcode: p.gtin ?? undefined,
            weightKg: p.weight_kg ? Number(p.weight_kg) : undefined, images, quantity: shown,
          });
          await sql`update products set shopify_product_id = ${ids.productId}, shopify_variant_id = ${ids.variantId},
            shopify_inventory_item_id = ${ids.inventoryItemId}, shown_qty = ${shown} where sku = ${p.sku}`;
        }
        ok++;
      } catch (err) {
        failed.push(p.sku);
        logger.error({ sku: p.sku, err: String(err) }, 'falha ao publicar produto');
      }
    }
    return { total: rows.length, ok, failed };
  });
}

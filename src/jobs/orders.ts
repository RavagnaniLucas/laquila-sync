import { config } from '../config.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import * as blingApi from '../clients/bling.js';
import { LaquilaClient } from '../clients/laquila.js';
import * as shopify from '../clients/shopify.js';

/**
 * Pedido de ponta a ponta, como uma máquina de estados. Cada chamada de `advanceOrder`
 * tenta avançar UMA etapa; o worker chama de novo até parar num estado de espera.
 *
 *  received ─► bling_created ─► laquila_sent ─► laquila_invoiced ─► nfe_issued
 *     ─► xml_sent ─► label_sent ─► shipped ─► fulfilled
 *
 * Estados de espera (on_hold) guardam o motivo em last_error e voltam a andar
 * quando a condição muda (ex.: Laquila ligada, NF-e autorizada, etiqueta enviada).
 */

export type OrderStatus =
  | 'received' | 'bling_created' | 'laquila_sent' | 'laquila_invoiced' | 'nfe_issued'
  | 'xml_sent' | 'label_sent' | 'shipped' | 'fulfilled' | 'cancelled' | 'on_hold' | 'error';

export interface OrderRow {
  shopify_order_id: string;
  shopify_order_name: string;
  status: OrderStatus;
  customer: any;
  items: Array<{ sku: string; quantity: number; price: number; title: string }>;
  shipping: any;
  total: string | null;
  bling_order_id: string | null;
  bling_nfe_id: string | null;
  laquila_order_id: string | null;
  laquila_send_lock: Date | null;
  tracking_code: string | null;
  tracking_company: string | null;
  attempts: number;
  created_at: Date;
}

const laquila = new LaquilaClient();

/** Grava o pedido recebido do webhook orders/paid (idempotente). */
export async function ingestShopifyOrder(payload: any): Promise<string | null> {
  const id = `gid://shopify/Order/${payload.id}`;
  const items = (payload.line_items ?? [])
    .filter((li: any) => li.sku)
    .map((li: any) => ({ sku: String(li.sku), quantity: Number(li.quantity), price: Number(li.price), title: String(li.title) }));
  if (!items.length) return null;

  // Só pedidos com pelo menos um item da Laquila entram no fluxo.
  const skus = items.map((i: { sku: string }) => i.sku);
  const known = await sql<{ sku: string }[]>`select sku from products where sku in ${sql(skus)}`;
  const laquilaItems = items.filter((i: { sku: string }) => known.some((k) => k.sku === i.sku));
  if (!laquilaItems.length) return null;

  const addr = payload.shipping_address ?? payload.billing_address ?? {};
  const customer = {
    nome: [addr.first_name, addr.last_name].filter(Boolean).join(' ') || payload.customer?.first_name || 'Cliente',
    email: payload.email ?? payload.customer?.email,
    telefone: addr.phone ?? payload.phone ?? payload.customer?.phone ?? '',
    // CPF/CNPJ: no checkout brasileiro costuma vir em `company` ou num note_attribute.
    documento: findDocument(payload),
    endereco: {
      endereco: addr.address1 ?? '', numero: extractNumber(addr.address1), complemento: addr.address2 ?? '',
      bairro: addr.address2 ?? '', cep: (addr.zip ?? '').replace(/\D/g, ''), municipio: addr.city ?? '', uf: addr.province_code ?? '',
    },
  };

  await sql`
    insert into orders (shopify_order_id, shopify_order_name, customer, items, shipping, total)
    values (${id}, ${payload.name}, ${sql.json(customer)}, ${sql.json(laquilaItems)},
            ${sql.json(payload.shipping_lines ?? [])}, ${payload.total_price ?? null})
    on conflict (shopify_order_id) do nothing`;
  await event(id, 'received', { name: payload.name });
  return id;
}

export async function advanceOrder(id: string): Promise<OrderStatus> {
  const [o] = await sql<OrderRow[]>`select * from orders where shopify_order_id = ${id}`;
  if (!o) throw new Error(`pedido ${id} não existe`);
  try {
    const next = await step(o);
    if (next && next !== o.status) {
      await sql`update orders set status = ${next}, last_error = null, updated_at = now() where shopify_order_id = ${id}`;
      await event(id, next);
      return next;
    }
    return o.status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, status: o.status, err: msg }, 'falha ao avançar pedido');
    await sql`update orders set last_error = ${msg}, attempts = attempts + 1, updated_at = now() where shopify_order_id = ${id}`;
    await event(id, 'error', { at: o.status, message: msg });
    throw err;
  }
}

async function hold(o: OrderRow, reason: string): Promise<null> {
  await sql`update orders set last_error = ${reason}, updated_at = now() where shopify_order_id = ${o.shopify_order_id}`;
  return null;
}

async function step(o: OrderRow): Promise<OrderStatus | null> {
  switch (o.status) {
    case 'received': {
      if (!config.BLING_ENABLED) return hold(o, 'Aguardando conexão com o Bling (BLING_ENABLED=false)');
      const contatoId = await blingApi.upsertContact(o.customer);
      const products = await sql<{ sku: string; bling_id: string | null }[]>`
        select sku, bling_id from products where sku in ${sql(o.items.map((i) => i.sku))}`;
      const missing = products.filter((p) => !p.bling_id).map((p) => p.sku);
      if (missing.length) return hold(o, `Produtos sem cadastro no Bling: ${missing.join(', ')}`);
      const blingId = await blingApi.createSalesOrder({
        numeroLoja: o.shopify_order_name.replace('#', ''),
        data: o.created_at.toISOString().slice(0, 10),
        contatoId,
        itens: o.items.map((i) => ({
          produtoId: Number(products.find((p) => p.sku === i.sku)!.bling_id),
          sku: i.sku, quantidade: i.quantity, valor: i.price, descricao: i.title,
        })),
        frete: (o.shipping ?? []).reduce((s: number, l: any) => s + Number(l.price ?? 0), 0),
        observacoes: `Shopify ${o.shopify_order_name}`,
      });
      await sql`update orders set bling_order_id = ${blingId} where shopify_order_id = ${o.shopify_order_id}`;
      return 'bling_created';
    }

    case 'bling_created': {
      // >>> Ponto de entrada da Laquila. Enquanto não houver token, o pedido espera aqui. <<<
      if (!config.LAQUILA_ENABLED) return hold(o, 'Aguardando integração com a Laquila (LAQUILA_ENABLED=false)');
      if (!o.customer.documento) return hold(o, 'Pedido sem CPF/CNPJ do cliente');

      // Trava para nunca transmitir duas vezes (cada pedido custa R$ 8 e debita o saldo).
      const locked = await sql`
        update orders set laquila_send_lock = now()
        where shopify_order_id = ${o.shopify_order_id} and laquila_send_lock is null and laquila_order_id is null
        returning 1`;
      if (!locked.length) {
        return hold(o, 'Transmissão à Laquila já tentada: confira no painel da Laquila antes de liberar de novo');
      }
      const prices = await sql<{ sku: string; cost: string }[]>`select sku, cost from products where sku in ${sql(o.items.map((i) => i.sku))}`;
      const res = await laquila.createOrder({
        cpfCnpj: o.customer.documento,
        nome: o.customer.nome,
        email: o.customer.email ?? '',
        celular: o.customer.telefone ?? '',
        itens: o.items.map((i) => ({ sku: i.sku, qty: i.quantity, unitPrice: Number(prices.find((p) => p.sku === i.sku)?.cost ?? 0) })),
      });
      await event(o.shopify_order_id, 'laquila_response', res.raw);
      if (res.warning) await event(o.shopify_order_id, 'laquila_aviso_saldo', { mensagem: res.warning });
      if (!res.id) return hold(o, 'Laquila respondeu sem número de pedido: verificar resposta bruta no histórico');
      await sql`update orders set laquila_order_id = ${res.id} where shopify_order_id = ${o.shopify_order_id}`;
      return 'laquila_sent';
    }

    case 'laquila_sent': {
      // 00008 mostra quando a venda Laquila → você foi faturada (ex.: cd_situacao_venda "F").
      const st = await laquila.order(o.laquila_order_id!);
      if (st) await event(o.shopify_order_id, 'laquila_status', { venda: st.vendaSituacaoDesc, remessa: st.remessaSituacaoDesc });
      if (!st?.chaveNotaVenda && st?.vendaSituacao !== 'F') return hold(o, `Aguardando a Laquila faturar (${st?.vendaSituacaoDesc ?? 'sem status'})`);
      const xml = await laquila.invoiceXml(o.laquila_order_id!, 'V');
      if (!xml.includes('<nfeProc') && !xml.includes('<NFe')) return hold(o, 'Laquila faturou, mas o XML da NF de venda ainda não veio');
      await sql`insert into order_events (shopify_order_id, kind, detail) values (${o.shopify_order_id}, 'xml_venda', ${sql.json({ xml })})`;
      return 'laquila_invoiced';
    }

    case 'laquila_invoiced': {
      if (!o.bling_nfe_id) {
        const nfeId = await blingApi.generateInvoiceFromOrder(Number(o.bling_order_id));
        await sql`update orders set bling_nfe_id = ${nfeId} where shopify_order_id = ${o.shopify_order_id}`;
        return hold(o, 'NF-e gerada no Bling: revise e emita (até o contador validar a emissão automática)');
      }
      const nfe = await blingApi.getInvoice(Number(o.bling_nfe_id));
      // TODO confirmar códigos de situação da NF-e no Bling (5 = autorizada, 6 = emitida DANFE).
      if (![5, 6, 7].includes(Number(nfe?.data?.situacao))) return hold(o, 'Aguardando autorização da NF-e no Bling');
      return 'nfe_issued';
    }

    case 'nfe_issued': {
      const nfe = await blingApi.getInvoice(Number(o.bling_nfe_id));
      const xmlUrl: string | undefined = nfe?.data?.xml;
      const chave: string | undefined = nfe?.data?.chaveAcesso;
      if (!xmlUrl || !chave) return hold(o, 'NF-e sem XML ou chave de acesso no Bling');
      const xml = await (await fetch(xmlUrl)).text();
      await laquila.sendInvoiceXml(o.laquila_order_id!, xml, chave);
      return 'xml_sent';
    }

    case 'xml_sent':
      // A etiqueta é gerada por você (Correios, Melhor Envio...) e enviada pelo painel interno
      // (POST /admin/pedidos/:id/etiqueta), que chama o 00010 e grava o código de rastreio.
      return hold(o, 'Aguardando etiqueta de frete');

    case 'label_sent': {
      // O rastreio é o da etiqueta que você gerou. Aqui só esperamos a Laquila despachar,
      // o que aparece no 00008 como nota de remessa emitida.
      const st = await laquila.order(o.laquila_order_id!);
      if (!st?.notaRemessa && !st?.chaveNotaRemessa) return hold(o, `Aguardando despacho pela Laquila (${st?.remessaSituacaoDesc ?? 'sem status'})`);
      if (!o.tracking_code) return hold(o, 'Despachado, mas sem código de rastreio cadastrado');
      return 'shipped';
    }

    case 'shipped': {
      await shopify.fulfillOrder(o.shopify_order_id, { number: o.tracking_code!, company: o.tracking_company ?? 'Correios' });
      return 'fulfilled';
    }

    default:
      return null;
  }
}

/** Cancelamento vindo da Shopify. */
export async function cancelOrder(payload: any): Promise<void> {
  const id = `gid://shopify/Order/${payload.id}`;
  const [o] = await sql<OrderRow[]>`select * from orders where shopify_order_id = ${id}`;
  if (!o || o.status === 'cancelled') return;
  if (o.laquila_order_id && ['laquila_sent', 'laquila_invoiced', 'nfe_issued', 'xml_sent'].includes(o.status)) {
    await laquila.cancelOrder(o.laquila_order_id, `Cancelado pelo cliente na loja (${o.shopify_order_name})`);
  } else if (['label_sent', 'shipped', 'fulfilled'].includes(o.status)) {
    await event(id, 'cancel_after_shipping', { note: 'Já despachado: tratar como devolução' });
    return;
  }
  await sql`update orders set status = 'cancelled', updated_at = now() where shopify_order_id = ${id}`;
  await event(id, 'cancelled');
}

async function event(id: string, kind: string, detail?: unknown) {
  await sql`insert into order_events (shopify_order_id, kind, detail) values (${id}, ${kind}, ${detail ? sql.json(detail as any) : null})`;
}

export function findDocument(payload: any): string {
  const attrs: Array<{ name: string; value: string }> = payload.note_attributes ?? [];
  const fromAttr = attrs.find((a) => /cpf|cnpj|documento/i.test(a.name))?.value;
  const candidates = [fromAttr, payload.shipping_address?.company, payload.billing_address?.company];
  for (const c of candidates) {
    const d = String(c ?? '').replace(/\D/g, '');
    if (d.length === 11 || d.length === 14) return d;
  }
  return '';
}

export function extractNumber(address1: string | undefined): string {
  const m = /,\s*(\d+[A-Za-z]?)/.exec(address1 ?? '') ?? /\s(\d+[A-Za-z]?)\b/.exec(address1 ?? '');
  return m?.[1] ?? 'S/N';
}

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { HttpError, isTransient, withRetry } from '../lib/rate-limit.js';

/**
 * Cliente da Admin GraphQL API da Shopify.
 * Autenticação: app criado no Dev Dashboard, na mesma organização da loja, já instalado,
 * usando o client credentials grant. O token dura 24 h e não tem refresh: pedimos outro.
 */

let cached: { token: string; expiresAt: number } | null = null;

function shopDomain(): string {
  const shop = config.SHOPIFY_SHOP;
  if (!config.SHOPIFY_ENABLED || !shop) throw new Error('Shopify desligada: defina SHOPIFY_SHOP e SHOPIFY_ENABLED=true no .env');
  return shop.endsWith('.myshopify.com') ? shop : `${shop}.myshopify.com`;
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const res = await request(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.SHOPIFY_CLIENT_ID ?? '',
      client_secret: config.SHOPIFY_CLIENT_SECRET ?? '',
    }).toString(),
  });
  const json = (await res.body.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (res.statusCode >= 400 || !json.access_token) {
    throw new HttpError(`Shopify token falhou: ${json.error ?? res.statusCode} ${json.error_description ?? ''}`, res.statusCode, json);
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 86_399) * 1000 };
  return cached.token;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return withRetry(
    async () => {
      const token = await accessToken();
      const res = await request(`https://${shopDomain()}/admin/api/${config.SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables }),
      });
      const json = (await res.body.json()) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }>; extensions?: any };
      if (res.statusCode === 401) cached = null;
      if (res.statusCode >= 400) throw new HttpError(`Shopify HTTP ${res.statusCode}`, res.statusCode, json);
      if (json.errors?.length) {
        const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
        throw new HttpError(`Shopify: ${json.errors.map((e) => e.message).join('; ')}`, throttled ? 429 : 400, json.errors);
      }
      const cost = json.extensions?.cost;
      if (cost?.throttleStatus?.currentlyAvailable < 100) {
        // Dá tempo para o balde de custo recarregar antes da próxima chamada.
        await new Promise((r) => setTimeout(r, 1000));
      }
      return json.data as T;
    },
    { retryOn: (e) => isTransient(e) || (e instanceof HttpError && e.status === 401) },
  );
}

function assertNoUserErrors(where: string, errors: Array<{ field?: string[]; message: string }> | undefined): void {
  if (errors?.length) throw new HttpError(`${where}: ${errors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`).join('; ')}`, 422, errors);
}

// ---------- produtos e estoque ----------

export interface ShopifyProductInput {
  sku: string;
  title: string;
  descriptionHtml?: string;
  vendor?: string; // marca
  productType?: string; // categoria
  tags?: string[];
  price: number;
  compareAt?: number;
  cost?: number;
  barcode?: string;
  weightKg?: number;
  images?: string[];
  quantity?: number;
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
}

export const handleForSku = (sku: string) => `laquila-${sku.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const PRODUCT_SET = /* GraphQL */ `
  mutation productSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
      userErrors { field message code }
    }
  }`;

export function buildProductSetInput(p: ShopifyProductInput, locationId?: string) {
  return {
    title: p.title,
    handle: handleForSku(p.sku),
    descriptionHtml: p.descriptionHtml,
    vendor: p.vendor,
    productType: p.productType,
    tags: ['laquila', ...(p.tags ?? [])],
    status: p.status ?? 'DRAFT', // entra como rascunho até você aprovar
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    files: p.images?.map((url, i) => ({ originalSource: url, contentType: 'IMAGE', alt: `${p.title} ${i + 1}` })),
    variants: [
      {
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        sku: p.sku,
        price: p.price.toFixed(2),
        compareAtPrice: p.compareAt ? p.compareAt.toFixed(2) : null,
        barcodes: p.barcode ? [{ value: p.barcode }] : undefined,
        inventoryPolicy: 'DENY',
        inventoryItem: {
          sku: p.sku,
          tracked: true,
          cost: p.cost?.toFixed(2),
          measurement: p.weightKg ? { weight: { value: p.weightKg, unit: 'KILOGRAMS' } } : undefined,
        },
        inventoryQuantities:
          locationId && p.quantity != null ? [{ locationId, name: 'available', quantity: p.quantity }] : undefined,
      },
    ],
  };
}

/** Cria ou atualiza o produto (um SKU = um produto com uma variante). */
export async function upsertProduct(p: ShopifyProductInput): Promise<{ productId: string; variantId: string; inventoryItemId: string }> {
  const data = await gql<any>(PRODUCT_SET, {
    identifier: { handle: handleForSku(p.sku) },
    input: buildProductSetInput(p, config.SHOPIFY_LOCATION_ID),
  });
  assertNoUserErrors('productSet', data.productSet.userErrors);
  const prod = data.productSet.product;
  const variant = prod.variants.nodes[0];
  return { productId: prod.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id };
}

/** Atualiza só o preço (mais barato que productSet). */
export async function updatePrice(productId: string, variantId: string, price: number, compareAt?: number): Promise<void> {
  const data = await gql<any>(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: [{ id: variantId, price: price.toFixed(2), compareAtPrice: compareAt ? compareAt.toFixed(2) : null }] },
  );
  assertNoUserErrors('productVariantsBulkUpdate', data.productVariantsBulkUpdate.userErrors);
}

/** Define o estoque disponível de vários itens de uma vez (até 250 por chamada). */
export async function setQuantities(items: Array<{ inventoryItemId: string; quantity: number }>): Promise<void> {
  const locationId = config.SHOPIFY_LOCATION_ID;
  if (!locationId) throw new Error('Defina SHOPIFY_LOCATION_ID (veja `npm run cli -- shopify:locais`)');
  for (let i = 0; i < items.length; i += 250) {
    const chunk = items.slice(i, i + 250);
    const data = await gql<any>(
      `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { field message code } }
      }`,
      {
        key: randomUUID(),
        input: {
          name: 'available',
          reason: 'correction',
          referenceDocumentUri: `laquila://estoque/${new Date().toISOString()}`,
          // Somos a fonte da verdade do estoque desses itens: sem compare-and-swap.
          quantities: chunk.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId, quantity: c.quantity, changeFromQuantity: null })),
        },
      },
    );
    assertNoUserErrors('inventorySetQuantities', data.inventorySetQuantities.userErrors);
  }
}

export async function listLocations(): Promise<Array<{ id: string; name: string }>> {
  const data = await gql<any>(`{ locations(first: 50) { nodes { id name isActive } } }`);
  return data.locations.nodes;
}

// ---------- pedidos e envio ----------

/** Marca o pedido como enviado com o código de rastreio; a Shopify avisa o cliente. */
export async function fulfillOrder(orderGid: string, tracking: { number: string; company?: string; url?: string }): Promise<void> {
  const data = await gql<any>(
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: orderGid },
  );
  const open = data.order.fulfillmentOrders.nodes.filter((f: any) => ['OPEN', 'IN_PROGRESS'].includes(f.status));
  if (!open.length) {
    logger.warn({ orderGid }, 'pedido sem fulfillment order em aberto');
    return;
  }
  const res = await gql<any>(
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`,
    {
      f: {
        notifyCustomer: true,
        trackingInfo: { number: tracking.number, company: tracking.company, url: tracking.url },
        lineItemsByFulfillmentOrder: open.map((f: any) => ({ fulfillmentOrderId: f.id })),
      },
    },
  );
  assertNoUserErrors('fulfillmentCreate', res.fulfillmentCreate.userErrors);
}

export async function registerWebhooks(): Promise<string[]> {
  const topics = ['ORDERS_PAID', 'ORDERS_CANCELLED'];
  const created: string[] = [];
  for (const topic of topics) {
    const path = topic === 'ORDERS_PAID' ? 'orders-paid' : 'orders-cancelled';
    const data = await gql<any>(
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
      }`,
      { topic, sub: { uri: `${config.PUBLIC_URL}/webhooks/shopify/${path}`, format: 'JSON' } },
    );
    const errs = data.webhookSubscriptionCreate.userErrors as Array<{ message: string }>;
    if (errs.length && !errs.some((e) => /already|taken/i.test(e.message))) assertNoUserErrors('webhookSubscriptionCreate', errs);
    created.push(topic);
  }
  return created;
}

/** Valida o cabeçalho X-Shopify-Hmac-Sha256 com o client secret do app. */
export function verifyWebhook(rawBody: Buffer, hmacHeader: string | undefined, secret = config.SHOPIFY_CLIENT_SECRET): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, 'base64');
  return given.length === digest.length && timingSafeEqual(given, digest);
}

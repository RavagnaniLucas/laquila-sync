import { randomBytes } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { HttpError, RateLimiter, isTransient, withRetry } from '../lib/rate-limit.js';

/**
 * Cliente da API v3 do Bling (OAuth 2.0, authorization code).
 * - Access token dura cerca de 6 h; o refresh token roda a cada renovação e expira
 *   após cerca de 30 dias sem uso. Guardamos sempre o par novo no banco.
 * - Limite usado: 3 req/s. Não há sandbox: teste com produtos marcados como TESTE.
 *
 * Os endpoints e campos abaixo seguem a referência pública da v3; confirme no
 * primeiro teste real (veja `npm run cli -- bling:teste`).
 */

const AUTH_BASE = 'https://www.bling.com.br/Api/v3/oauth';
const API_BASE = process.env.BLING_API_BASE ?? 'https://api.bling.com.br/Api/v3';
const limiter = new RateLimiter(3);

const pendingStates = new Map<string, number>();

export function blingRedirectUri(): string {
  return `${config.PUBLIC_URL}/bling/callback`;
}

export function blingAuthorizeUrl(): string {
  if (!config.BLING_CLIENT_ID) throw new Error('Defina BLING_CLIENT_ID no .env');
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const qs = new URLSearchParams({ response_type: 'code', client_id: config.BLING_CLIENT_ID, state });
  return `${AUTH_BASE}/authorize?${qs}`;
}

export function consumeState(state: string): boolean {
  const at = pendingStates.get(state);
  pendingStates.delete(state);
  return !!at && Date.now() - at < 15 * 60_000;
}

async function tokenRequest(form: Record<string, string>): Promise<void> {
  const basic = Buffer.from(`${config.BLING_CLIENT_ID}:${config.BLING_CLIENT_SECRET}`).toString('base64');
  const res = await request(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: '1.0' },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.body.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: unknown };
  if (res.statusCode >= 400 || !json.access_token) {
    throw new HttpError(`Bling OAuth falhou (HTTP ${res.statusCode}). Refaça a conexão em /bling/conectar`, res.statusCode, json.error);
  }
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21_600) * 1000);
  await sql`
    insert into oauth_tokens (provider, access_token, refresh_token, expires_at)
    values ('bling', ${json.access_token}, ${json.refresh_token ?? null}, ${expiresAt})
    on conflict (provider) do update set access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, oauth_tokens.refresh_token),
      expires_at = excluded.expires_at, updated_at = now()`;
}

export async function exchangeBlingCode(code: string): Promise<void> {
  await tokenRequest({ grant_type: 'authorization_code', code });
  logger.info('Bling conectado');
}

let refreshing: Promise<void> | null = null;

async function accessToken(): Promise<string> {
  if (!config.BLING_ENABLED) throw new Error('Bling desligado: defina BLING_ENABLED=true no .env');
  const [row] = await sql<{ access_token: string; refresh_token: string | null; expires_at: Date }[]>`
    select access_token, refresh_token, expires_at from oauth_tokens where provider = 'bling'`;
  if (!row) throw new Error(`Bling ainda não conectado. Abra ${config.PUBLIC_URL}/bling/conectar`);
  if (row.expires_at.getTime() - Date.now() > 5 * 60_000) return row.access_token;
  if (!row.refresh_token) throw new Error('Bling sem refresh token: conecte de novo em /bling/conectar');
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token }).finally(() => {
    refreshing = null;
  });
  await refreshing;
  return accessToken();
}

export async function bling<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return withRetry(
    () =>
      limiter.schedule(async () => {
        const token = await accessToken();
        const res = await request(`${API_BASE}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.body.text();
        const json = text ? JSON.parse(text) : {};
        if (res.statusCode === 401) {
          await sql`update oauth_tokens set expires_at = now() where provider = 'bling'`; // força renovar
        }
        if (res.statusCode >= 400) throw new HttpError(`Bling ${method} ${path} HTTP ${res.statusCode}`, res.statusCode, json?.error ?? json);
        return json as T;
      }),
    { retryOn: (e) => isTransient(e) || (e instanceof HttpError && e.status === 401) },
  );
}

// ---------- recursos ----------

export interface BlingProductInput {
  sku: string;
  nome: string;
  preco: number;
  precoCusto?: number;
  marca?: string;
  ncm?: string;
  gtin?: string;
  pesoKg?: number;
  descricaoHtml?: string;
  imagens?: string[];
}

export async function findProductBySku(sku: string): Promise<{ id: number } | null> {
  const res = await bling<{ data?: Array<{ id: number; codigo: string }> }>('GET', `/produtos?codigo=${encodeURIComponent(sku)}`);
  return res.data?.find((p) => p.codigo === sku) ?? null;
}

export function toBlingProduct(p: BlingProductInput) {
  return {
    nome: p.nome.slice(0, 120),
    codigo: p.sku,
    preco: p.preco,
    precoCusto: p.precoCusto,
    tipo: 'P',
    situacao: 'A',
    formato: 'S',
    unidade: 'UN',
    marca: p.marca,
    gtin: p.gtin,
    pesoLiquido: p.pesoKg,
    pesoBruto: p.pesoKg,
    descricaoCurta: p.descricaoHtml,
    tributacao: p.ncm ? { ncm: p.ncm } : undefined,
    midia: p.imagens?.length ? { imagens: { externas: p.imagens.map((link) => ({ link })) } } : undefined,
  };
}

/** Cria ou atualiza o produto pelo SKU. Devolve o id do Bling. */
export async function upsertProduct(p: BlingProductInput, knownId?: number | null): Promise<number> {
  const id = knownId ?? (await findProductBySku(p.sku))?.id;
  const payload = toBlingProduct(p);
  if (id) {
    await bling('PUT', `/produtos/${id}`, payload);
    return id;
  }
  const res = await bling<{ data: { id: number } }>('POST', '/produtos', payload);
  return res.data.id;
}

/** Balanço de estoque (operação B = define o saldo) no depósito configurado. */
export async function setStock(productId: number, qty: number): Promise<void> {
  if (!config.BLING_DEPOSITO_ID) throw new Error('Defina BLING_DEPOSITO_ID (veja `npm run cli -- bling:depositos`)');
  await bling('POST', '/estoques', {
    produto: { id: productId },
    deposito: { id: config.BLING_DEPOSITO_ID },
    operacao: 'B',
    quantidade: qty,
    observacoes: 'Sincronizado com o saldo da Laquila',
  });
}

export async function listDeposits(): Promise<unknown> {
  return bling('GET', '/depositos');
}

export interface BlingCustomer {
  nome: string;
  documento: string; // CPF/CNPJ
  email?: string;
  telefone?: string;
  endereco?: { endereco: string; numero: string; complemento?: string; bairro: string; cep: string; municipio: string; uf: string };
}

export async function upsertContact(c: BlingCustomer): Promise<number> {
  const doc = c.documento.replace(/\D/g, '');
  const found = await bling<{ data?: Array<{ id: number }> }>('GET', `/contatos?numeroDocumento=${doc}`);
  const payload = {
    nome: c.nome,
    tipo: doc.length > 11 ? 'J' : 'F',
    numeroDocumento: doc,
    email: c.email,
    celular: c.telefone,
    situacao: 'A',
    endereco: c.endereco ? { geral: c.endereco } : undefined,
  };
  const existing = found.data?.[0];
  if (existing) {
    await bling('PUT', `/contatos/${existing.id}`, payload);
    return existing.id;
  }
  const res = await bling<{ data: { id: number } }>('POST', '/contatos', payload);
  return res.data.id;
}

export interface BlingOrderInput {
  numeroLoja: string; // número do pedido na Shopify
  data: string; // YYYY-MM-DD
  contatoId: number;
  itens: Array<{ produtoId: number; sku: string; quantidade: number; valor: number; descricao: string }>;
  frete?: number;
  observacoes?: string;
}

export async function createSalesOrder(o: BlingOrderInput): Promise<number> {
  const res = await bling<{ data: { id: number } }>('POST', '/pedidos/vendas', {
    numeroLoja: o.numeroLoja,
    data: o.data,
    contato: { id: o.contatoId },
    itens: o.itens.map((i) => ({ produto: { id: i.produtoId }, codigo: i.sku, descricao: i.descricao, quantidade: i.quantidade, valor: i.valor })),
    transporte: o.frete ? { frete: o.frete } : undefined,
    observacoes: o.observacoes,
  });
  return res.data.id;
}

/** Gera a NF-e a partir do pedido de venda (fica como rascunho no Bling). */
export async function generateInvoiceFromOrder(orderId: number): Promise<number | null> {
  const res = await bling<{ data?: { id?: number; idNotaFiscal?: number } }>('POST', `/pedidos/vendas/${orderId}/gerar-nfe`);
  return res.data?.idNotaFiscal ?? res.data?.id ?? null;
}

/** Transmite a NF-e à SEFAZ. Só ligar depois que o contador validar o fluxo fiscal. */
export async function sendInvoice(nfeId: number): Promise<unknown> {
  return bling('POST', `/nfe/${nfeId}/enviar`);
}

export async function getInvoice(nfeId: number): Promise<any> {
  return bling('GET', `/nfe/${nfeId}`);
}

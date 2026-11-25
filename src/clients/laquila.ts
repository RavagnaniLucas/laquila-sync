import { request } from 'undici';
import { config } from '../config.js';
import { logger, maskUrl } from '../lib/logger.js';
import { HttpError, RateLimiter, isTransient, withRetry } from '../lib/rate-limit.js';

/**
 * Cliente da API de dropshipping da Laquila.
 * Doc: "Nova API Dropshipping Laquila" (PDF). Formato: POST {base}/{token}/{método} com JSON.
 *
 * ATENÇÃO: o PDF só documenta as mudanças. Os métodos marcados com TODO têm request/response
 * "sem alterações" em relação a uma documentação anterior que ainda não recebemos.
 * Os nomes de campo seguem os exemplos do PDF, que têm alguns espaços sobrando
 * (ex.: "vl_preco "); por isso a leitura usa `field()`, que tolera isso.
 */

const limiter = new RateLimiter(2); // limite real desconhecido: começamos conservadores

export interface LaquilaStock {
  cadastro: string;
  sku: string;
  qty: number;
  qtyMax: number | null;
}

export interface LaquilaPrice {
  cadastro: string;
  sku: string;
  cost: number;
  suggested: number;
  qtyMin: number | null;
  qtyMax: number | null;
}

export interface LaquilaOrderInput {
  cpfCnpj: string;
  nome: string;
  email: string;
  celular: string;
  itens: Array<{ sku: string; qty: number; unitPrice: number }>;
}

export class LaquilaClient {
  constructor(
    private readonly token = config.LAQUILA_TOKEN,
    private readonly base = config.LAQUILA_BASE_URL,
  ) {}

  private ensureEnabled(): string {
    if (!config.LAQUILA_ENABLED || !this.token) {
      throw new Error('Laquila desligada: defina LAQUILA_TOKEN e LAQUILA_ENABLED=true no .env');
    }
    return this.token;
  }

  private auth() {
    const base: Record<string, string> = { cnpj_empresa: config.LAQUILA_CNPJ_EMPRESA, token: this.ensureEnabled() };
    if (config.LAQUILA_CPF_CNPJ_CONSULTA) base.cpf_cnpj_consulta = config.LAQUILA_CPF_CNPJ_CONSULTA;
    return base;
  }

  async call<T = unknown>(method: string, body: unknown, accept: 'json' | 'xml' = 'json'): Promise<T> {
    const token = this.ensureEnabled();
    const url = `${this.base}/${token}/${method}`;
    return withRetry(
      () =>
        limiter.schedule(async () => {
          const started = Date.now();
          const res = await request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: accept === 'xml' ? 'application/xml' : 'application/json' },
            body: JSON.stringify(body),
            headersTimeout: 60_000,
            bodyTimeout: 120_000,
          });
          const text = await res.body.text();
          logger.debug({ url: maskUrl(url), status: res.statusCode, ms: Date.now() - started }, 'laquila');
          if (res.statusCode >= 400) throw new HttpError(`Laquila ${method} HTTP ${res.statusCode}`, res.statusCode, text.slice(0, 500));
          if (accept === 'xml') return text as T;
          const json = text ? JSON.parse(text) : {};
          if (json && typeof json === 'object' && 'erro' in json) {
            throw new HttpError(`Laquila ${method}: ${String((json as { erro: unknown }).erro)}`, 422, json);
          }
          return json as T;
        }),
      { retryOn: isTransient },
    );
  }

  /** 00017 — só saldo, paginado (até 10.000 itens por página). */
  async *stock(pageSize = 10_000): AsyncGenerator<LaquilaStock[]> {
    for (let page = 1; ; page++) {
      const res = await this.call<unknown>('00017', {
        pedido: { ...this.auth(), pagina: String(page), itensporpagina: String(pageSize), cd_item: '' },
      });
      const items = extractItems(res).map((it) => ({
        cadastro: str(field(it, 'cd_cadastro')),
        sku: str(field(it, 'cd_item')),
        qty: num(field(it, 'qt_saldo')) ?? 0,
        qtyMax: num(field(it, 'qt_maxima')),
      }));
      if (items.length) yield items;
      if (items.length < pageSize) return;
    }
  }

  /** 00018 — só preço (custo, sugerido, qtd. mínima e máxima). */
  async *prices(pageSize = 10_000): AsyncGenerator<LaquilaPrice[]> {
    for (let page = 1; ; page++) {
      const res = await this.call<unknown>('00018', {
        pedido: { ...this.auth(), pagina: String(page), itensporpagina: String(pageSize), cd_item: '' },
      });
      const items = extractItems(res).map((it) => ({
        cadastro: str(field(it, 'cd_cadastro')),
        sku: str(field(it, 'cd_item')),
        cost: num(field(it, 'vl_preco')) ?? 0,
        suggested: num(field(it, 'vl_sugerido')) ?? 0,
        qtyMin: num(field(it, 'qt_minima')),
        qtyMax: num(field(it, 'qt_maxima')),
      }));
      if (items.length) yield items;
      if (items.length < pageSize) return;
    }
  }

  /** 00007 — consultar item. TODO: formato não documentado; guardamos a resposta bruta. */
  async item(sku: string): Promise<unknown> {
    return this.call('00007', { pedido: { ...this.auth(), cd_item: sku } });
  }

  /**
   * 00002 — inserir pedido. Debita o saldo pré-pago e custa R$ 8.
   * O formato da resposta não está documentado: devolvemos o JSON bruto e
   * `extractOrderId` tenta achar o número do pedido.
   * Não reenvie em caso de erro de rede sem conferir antes no 00008 (o novo 00002 não aceita
   * mais o número do seu pedido, então não há como a Laquila deduplicar).
   */
  async createOrder(o: LaquilaOrderInput): Promise<{ id: string | null; raw: unknown }> {
    if (!config.LAQUILA_CD_TRANSPORTADOR) throw new Error('Defina LAQUILA_CD_TRANSPORTADOR (código fornecido pela Laquila)');
    const raw = await this.callOnce('00002', {
      pedido: {
        ...this.auth(),
        cpf_cnpj: digits(o.cpfCnpj),
        nm_cliente: o.nome,
        email: o.email,
        nr_celular: digits(o.celular),
        cd_transportador: config.LAQUILA_CD_TRANSPORTADOR,
        itens: o.itens.map((i) => ({ cd_item: i.sku, qt_pedida: i.qty.toFixed(2), vl_unitario: i.unitPrice.toFixed(2) })),
      },
    });
    return { id: extractOrderId(raw), raw };
  }

  /** Igual a `call`, mas sem novas tentativas: usado onde repetir custa dinheiro. */
  private async callOnce(method: string, body: unknown): Promise<unknown> {
    const token = this.ensureEnabled();
    const url = `${this.base}/${token}/${method}`;
    const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new HttpError(`Laquila ${method} HTTP ${res.statusCode}`, res.statusCode, text.slice(0, 500));
    const json = text ? JSON.parse(text) : {};
    if (json && typeof json === 'object' && 'erro' in json) throw new HttpError(`Laquila ${method}: ${String(json.erro)}`, 422, json);
    return json;
  }

  /** 00008 — listar pedidos. TODO: filtros e resposta não documentados. */
  async listOrders(filter: Record<string, string> = {}): Promise<unknown> {
    return this.call('00008', { pedido: { ...this.auth(), ...filter } });
  }

  /** 00009 — cancelar pedido (motivo com pelo menos 10 caracteres). */
  async cancelOrder(id: string, motivo: string): Promise<unknown> {
    if (motivo.trim().length < 10) throw new Error('Motivo do cancelamento precisa de 10+ caracteres');
    return this.call('00009', { pedido: { ...this.auth(), id_pedido: id, motivo_cancelamento: motivo } });
  }

  /** 00012 — XML da NF de venda (V: Laquila → você) ou de remessa (R: Laquila → consumidor). */
  async invoiceXml(id: string, tipo: 'V' | 'R'): Promise<string> {
    const { cpf_cnpj_consulta: _ignored, ...auth } = this.auth();
    return this.call<string>('00012', { filtro: { ...auth, id_pedido: id, tipo } }, 'xml');
  }

  /** 00003 — enviar o XML da sua NF-e ao consumidor. TODO: campos não documentados. */
  async sendInvoiceXml(id: string, xml: string): Promise<unknown> {
    return this.call('00003', { pedido: { ...this.auth(), id_pedido: id, xml } });
  }

  /** 00010 — enviar etiqueta de frete. TODO: formato (PDF base64? ZPL?) não documentado. */
  async sendLabel(id: string, label: { base64: string; format: string }): Promise<unknown> {
    return this.call('00010', { pedido: { ...this.auth(), id_pedido: id, etiqueta: label.base64, formato: label.format } });
  }

  /** 00015 — transportadora da remessa. TODO: resposta não documentada. */
  async shipment(id: string): Promise<unknown> {
    return this.call('00015', { pedido: { ...this.auth(), id_pedido: id } });
  }
}

// ---------- utilitários de leitura tolerante ----------

/** Aceita { resultados: { itens: [ { item: {...} } ] } } e variações. */
export function extractItems(res: unknown): Record<string, unknown>[] {
  const r = res as { resultados?: { itens?: unknown[] }; itens?: unknown[] } | unknown[];
  const list = Array.isArray(r) ? r : (r?.resultados?.itens ?? r?.itens ?? []);
  return (list as unknown[]).map((x) => {
    const o = x as Record<string, unknown>;
    return (o && typeof o === 'object' && 'item' in o ? o.item : o) as Record<string, unknown>;
  });
}

/** Lê um campo ignorando espaços sobrando no nome (o PDF tem "vl_preco "). */
export function field(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name];
  const key = Object.keys(obj).find((k) => k.trim().toLowerCase() === name.toLowerCase());
  return key ? obj[key] : undefined;
}

export function extractOrderId(raw: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      if (/^(id_pedido|nr_pedido|pedido_id|id)$/i.test(k.trim()) && (typeof val === 'string' || typeof val === 'number')) return String(val);
    }
    for (const val of Object.values(v)) {
      const found = walk(val);
      if (found) return found;
    }
    return null;
  };
  return walk(raw);
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const digits = (s: string) => s.replace(/\D/g, '');

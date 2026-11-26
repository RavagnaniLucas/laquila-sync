import { request } from 'undici';
import { config } from '../config.js';
import { logger, maskUrl } from '../lib/logger.js';
import { HttpError, RateLimiter, isTransient, withRetry } from '../lib/rate-limit.js';

/**
 * Cliente da API de dropshipping da Laquila.
 * Documentação oficial: https://api-dropshipping.laquila.com.br/docs/
 * Formato: POST {base}/{token}/{método} com JSON. Todo corpo leva `token` e `cnpj_empresa`.
 * A chave raiz muda por método: "pedido" (00002), "dados" (00003, 00009, 00010)
 * e "filtro" (consultas: 00004, 00006, 00007, 00008, 00012, 00015, 00017, 00018).
 *
 * Limites documentados (por token):
 * - 00004 (limite/saldo financeiro): 6 consultas por hora.
 * - 00006 e 00017 (saldo): 3 consultas por hora, sempre com pagina=1 e itensporpagina=10000.
 *   Passou disso: HTTP 429 com {"erro": "..."} dizendo quando libera.
 * Valores numéricos vêm como texto com vírgula decimal.
 */

const limiter = new RateLimiter(2);

type Root = 'pedido' | 'dados' | 'filtro';

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

export interface LaquilaItem {
  sku: string;
  title: string;
  description: string;
  gtin: string | null;
  ncm: string | null;
  unit: string | null;
  weightNetKg: number | null;
  weightGrossKg: number | null;
  widthCm: number | null;
  heightCm: number | null;
  lengthCm: number | null;
  active: boolean;
  groups: { ggrupo: string | null; grupo: string | null; sgrupo: string | null };
  raw: Record<string, unknown>;
}

export interface LaquilaItemFilter {
  cd_item?: string;
  ds_item?: string;
  ds_ggrupo?: string;
  ds_grupo?: string;
  ds_sgrupo?: string;
  ds_marca?: string;
}

export interface LaquilaOrderInput {
  cpfCnpj: string;
  nome: string;
  email: string;
  celular: string;
  itens: Array<{ sku: string; qty: number; unitPrice: number }>;
}

export interface LaquilaOrderStatus {
  id: string;
  vendaSituacao: string | null; // cd_situacao_venda, ex.: "F"
  vendaSituacaoDesc: string | null; // ds_situacao_venda, ex.: "FATURADO"
  vendaEstagio: string | null;
  remessaSituacao: string | null;
  remessaSituacaoDesc: string | null;
  remessaEstagio: string | null;
  remessaEstagioDesc: string | null;
  notaVenda: string | null;
  chaveNotaVenda: string | null;
  notaRemessa: string | null;
  chaveNotaRemessa: string | null;
  raw: Record<string, unknown>;
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

  private auth(withConsulta = true): Record<string, string> {
    const base: Record<string, string> = { token: this.ensureEnabled(), cnpj_empresa: config.LAQUILA_CNPJ_EMPRESA };
    if (withConsulta && config.LAQUILA_CPF_CNPJ_CONSULTA) base.cpf_cnpj_consulta = digits(config.LAQUILA_CPF_CNPJ_CONSULTA);
    return base;
  }

  private body(root: Root, fields: Record<string, unknown>, withConsulta = true) {
    return { [root]: { ...this.auth(withConsulta), ...fields } };
  }

  /** Chamada com novas tentativas (só para consultas, que podem ser repetidas). */
  async call<T = unknown>(method: string, body: unknown, accept: 'json' | 'xml' = 'json'): Promise<T> {
    return withRetry(() => limiter.schedule(() => this.raw<T>(method, body, accept)), {
      // 429 da Laquila é janela de uma hora: não adianta insistir.
      retryOn: (e) => isTransient(e) && !(e instanceof HttpError && e.status === 429),
    });
  }

  /** Chamada única, sem repetição: usada onde repetir custa dinheiro ou duplica algo. */
  async callOnce<T = unknown>(method: string, body: unknown): Promise<T> {
    return limiter.schedule(() => this.raw<T>(method, body, 'json'));
  }

  private async raw<T>(method: string, body: unknown, accept: 'json' | 'xml'): Promise<T> {
    const token = this.ensureEnabled();
    const url = `${this.base}/${token}/${method}`;
    const started = Date.now();
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: accept === 'xml' ? 'application/xml' : 'application/json' },
      body: JSON.stringify(body),
      headersTimeout: 60_000,
      bodyTimeout: 180_000,
    });
    const text = await res.body.text();
    logger.debug({ url: maskUrl(url), status: res.statusCode, ms: Date.now() - started }, 'laquila');
    const json = accept === 'json' || !text.trimStart().startsWith('<') ? safeJson(text) : null;
    if (res.statusCode >= 400) {
      const msg = json && typeof json === 'object' && 'erro' in json ? String((json as any).erro) : text.slice(0, 300);
      throw new HttpError(`Laquila ${method} HTTP ${res.statusCode}: ${msg}`, res.statusCode, json ?? text.slice(0, 500));
    }
    if (json && typeof json === 'object' && 'erro' in json) {
      throw new HttpError(`Laquila ${method}: ${String((json as { erro: unknown }).erro)}`, 422, json);
    }
    return (accept === 'xml' ? text : json) as T;
  }

  /**
   * 00017 — só saldo. A Laquila exige pagina=1 e itensporpagina=10000 e aceita 3 consultas
   * por hora, então isto é uma "foto" completa do saldo, sem paginação.
   */
  async stock(): Promise<LaquilaStock[]> {
    const res = await this.call('00017', this.body('filtro', { pagina: '1', itensporpagina: '10000', cd_item: '' }, false));
    return extractItems(res).map((it) => ({
      cadastro: str(field(it, 'cd_cadastro')),
      sku: str(field(it, 'cd_item')),
      qty: num(field(it, 'qt_saldo')) ?? 0,
      qtyMax: num(field(it, 'qt_maxima')),
    }));
  }

  /** 00018 — só preço (custo, sugerido, qtd. mínima e máxima), paginado. */
  async *prices(pageSize = 10_000): AsyncGenerator<LaquilaPrice[]> {
    for (let page = 1; ; page++) {
      const res = await this.call('00018', this.body('filtro', { pagina: String(page), itensporpagina: String(pageSize), cd_item: '' }));
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

  /** 00007 — dados cadastrais dos itens (descrição, EAN, NCM, peso, caixa), paginado e filtrável. */
  async *items(filter: LaquilaItemFilter = {}, pageSize = 500): AsyncGenerator<LaquilaItem[]> {
    for (let page = 1; ; page++) {
      const res = await this.call('00007', this.body('filtro', { pagina: String(page), itensporpagina: String(pageSize), ...filter }, false));
      const items = extractItems(res).map(parseItem);
      if (items.length) yield items;
      if (items.length < pageSize) return;
    }
  }

  async item(sku: string): Promise<LaquilaItem | null> {
    for await (const page of this.items({ cd_item: sku }, 10)) return page.find((i) => i.sku === sku) ?? null;
    return null;
  }

  /** 00004 — limite/saldo financeiro do lojista (6 consultas por hora). Resposta devolvida bruta. */
  async credit(): Promise<unknown> {
    return this.call('00004', this.body('filtro', {}));
  }

  /** 00015 — lista de transportadoras (código, CNPJ, descrição). */
  async carriers(): Promise<Array<{ code: string; cnpj: string; name: string }>> {
    const res: any = await this.call('00015', this.body('filtro', {}, false));
    const list: any[] = res?.resultados?.transportadores ?? res?.transportadores ?? [];
    return list.map((x) => {
      const t = x?.transportador ?? x;
      return { code: str(field(t, 'cd_transportador')), cnpj: str(field(t, 'cnpj_transportador')), name: str(field(t, 'descricao')) };
    });
  }

  /**
   * 00002 — inserir pedido. Debita o saldo e custa R$ 8. Nunca repetir automaticamente:
   * a Laquila não recebe o número do seu pedido, então não há como ela deduplicar.
   */
  async createOrder(o: LaquilaOrderInput): Promise<{ id: string | null; warning: string | null; raw: unknown }> {
    if (!config.LAQUILA_CD_TRANSPORTADOR) throw new Error('Defina LAQUILA_CD_TRANSPORTADOR (veja `npm run cli -- laquila:transportadoras`)');
    const raw = await this.callOnce('00002', this.body('pedido', buildOrderFields(o, config.LAQUILA_CD_TRANSPORTADOR)));
    const first: any = Array.isArray((raw as any)?.resultado) ? (raw as any).resultado[0]?.pedido : undefined;
    const id = first?.id_pedido != null ? String(first.id_pedido) : extractOrderId(raw);
    return { id, warning: first?.mensagem ? String(first.mensagem) : null, raw };
  }

  /** 00008 — consulta de pedidos (status da venda e da remessa, notas). */
  async order(id: string): Promise<LaquilaOrderStatus | null> {
    const res: any = await this.call('00008', this.body('filtro', { pagina: '1', itensporpagina: '10', id_pedido: id }, false));
    const list: any[] = res?.resultado ?? res?.resultados?.pedidos ?? [];
    const p = list.map((x) => x?.pedido ?? x).find((x) => str(field(x, 'id_pedido')) === id) ?? list[0]?.pedido;
    return p ? parseOrder(p) : null;
  }

  /** 00009 — cancelar pedido (motivo com pelo menos 10 caracteres). */
  async cancelOrder(id: string, motivo: string): Promise<unknown> {
    if (motivo.trim().length < 10) throw new Error('Motivo do cancelamento precisa de 10+ caracteres');
    return this.callOnce('00009', this.body('dados', { id_pedido: id, motivo_cancelamento: motivo }, false));
  }

  /** 00012 — XML da NF de venda (V: Laquila → você) ou de remessa (R: Laquila → consumidor). */
  async invoiceXml(id: string, tipo: 'V' | 'R'): Promise<string> {
    return this.call<string>('00012', this.body('filtro', { id_pedido: id, tipo }, false), 'xml');
  }

  /** 00003 — envia à Laquila o XML da sua NF-e ao consumidor (Base64). */
  async sendInvoiceXml(id: string, xml: string, chaveAcesso: string): Promise<unknown> {
    return this.callOnce(
      '00003',
      this.body('dados', { id_pedido: id, ch_acesso: chaveAcesso, xml: Buffer.from(xml, 'utf8').toString('base64'), nm_arquivo: `${chaveAcesso}.xml` }, false),
    );
  }

  /** 00010 — envia a etiqueta de frete (arquivo em Base64, normalmente PDF). */
  async sendLabel(id: string, label: { base64: string; fileName: string }): Promise<unknown> {
    return this.callOnce('00010', this.body('dados', { id_pedido: id, arquivo: label.base64, nm_arquivo: label.fileName }, false));
  }
}

// ---------- montagem e leitura ----------

export function buildOrderFields(o: LaquilaOrderInput, carrier: string) {
  const consulta = config.LAQUILA_CPF_CNPJ_CONSULTA ? digits(config.LAQUILA_CPF_CNPJ_CONSULTA) : undefined;
  return {
    cpf_cnpj: digits(o.cpfCnpj),
    ...(consulta ? { cpf_cnpj_consulta: consulta } : {}),
    nm_cliente: o.nome.slice(0, 100),
    email: o.email,
    nr_celular: digits(o.celular),
    cd_transportador: carrier,
    itens: o.itens.map((i) => ({ cd_item: i.sku, qt_pedida: String(i.qty), vl_unitario: i.unitPrice.toFixed(2) })),
  };
}

export function parseItem(it: Record<string, unknown>): LaquilaItem {
  const situacao = str(field(it, 'situacao')).toUpperCase();
  return {
    sku: str(field(it, 'cd_item')),
    title: str(field(it, 'descricao')),
    description: str(field(it, 'descrição_complem') ?? field(it, 'descricao_complem')),
    gtin: nonEmpty(digits(str(field(it, 'cd_ean')))),
    ncm: nonEmpty(digits(str(field(it, 'NCM')))),
    unit: nonEmpty(str(field(it, 'unidade'))),
    weightNetKg: num(field(it, 'peso_liquido')),
    weightGrossKg: num(field(it, 'peso_bruto')),
    widthCm: num(field(it, 'largura_caixa')),
    heightCm: num(field(it, 'altura_caixa')),
    lengthCm: num(field(it, 'complemento_caixa')),
    active: situacao === '' || situacao === 'A' || situacao.startsWith('ATIV'),
    groups: { ggrupo: nonEmpty(str(field(it, 'cd_ggrupo'))), grupo: nonEmpty(str(field(it, 'cd_grupo'))), sgrupo: nonEmpty(str(field(it, 'cd_sgrupo'))) },
    raw: it,
  };
}

export function parseOrder(p: Record<string, unknown>): LaquilaOrderStatus {
  const s = (k: string) => nonEmpty(str(field(p, k)));
  return {
    id: str(field(p, 'id_pedido')),
    vendaSituacao: s('cd_situacao_venda'),
    vendaSituacaoDesc: s('ds_situacao_venda'),
    vendaEstagio: s('ds_estagio_venda'),
    remessaSituacao: s('cd_situacao_remessa'),
    remessaSituacaoDesc: s('ds_situacao_remessa'),
    remessaEstagio: s('cd_estagio_remessa'),
    remessaEstagioDesc: s('ds_estagio_remessa'),
    notaVenda: s('nr_nota_venda'),
    chaveNotaVenda: s('ch_acesso_nota_venda'),
    notaRemessa: s('nr_nota_remessa'),
    chaveNotaRemessa: s('ch_acesso_remessa'),
    raw: p,
  };
}

/** Aceita { resultados: { itens: [ { item: {...} } ] } }, { resultado: [...] } e listas simples. */
export function extractItems(res: unknown): Record<string, unknown>[] {
  const r = res as any;
  const list = Array.isArray(r) ? r : (r?.resultados?.itens ?? r?.resultado ?? r?.itens ?? []);
  return (list as unknown[]).map((x) => {
    const o = x as Record<string, unknown>;
    return (o && typeof o === 'object' && 'item' in o ? o.item : o) as Record<string, unknown>;
  });
}

/** Lê um campo ignorando espaços sobrando e caixa no nome (o PDF tem "vl_preco "). */
export function field(obj: Record<string, unknown> | null | undefined, name: string): unknown {
  if (!obj) return undefined;
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
      if (/^(id_pedido|nr_pedido|pedido_id)$/i.test(k.trim()) && (typeof val === 'string' || typeof val === 'number')) return String(val);
    }
    for (const val of Object.values(v)) {
      const found = walk(val);
      if (found) return found;
    }
    return null;
  };
  return walk(raw);
}

/** Converte "1.234,56", "37,50", "37.50" ou 37.5 em número. */
export function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const nonEmpty = (s: string) => (s ? s : null);
const digits = (s: string) => s.replace(/\D/g, '');
function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LaquilaClient, extractItems, extractOrderId, field, num } from '../src/clients/laquila.js';
import { buildProductSetInput, handleForSku, verifyWebhook } from '../src/clients/shopify.js';
import { toBlingProduct } from '../src/clients/bling.js';
import { extractNumber, findDocument } from '../src/jobs/orders.js';

// Servidor falso da Laquila, no formato da documentação oficial (/docs).
let server: Server;
let base = '';
const calls: Array<{ url: string; body: any }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push({ url: req.url!, body });
      res.setHeader('content-type', 'application/json');
      const m = req.url!.split('/').pop();
      const send = (o: unknown, code = 200) => {
        res.statusCode = code;
        res.end(JSON.stringify(o));
      };
      switch (m) {
        case '00017':
          if (body.filtro?.itensporpagina !== '10000') return send({ erro: 'Limite excedido' }, 429);
          return send({ resultados: { itens: [
            { item: { cd_cadastro: '1234567', cd_item: '1111111', qt_saldo: '46', qt_maxima: '', nr_registro: '1' } },
            { item: { cd_cadastro: '1234567', cd_item: '2222222', qt_saldo: '0,00', qt_maxima: '3', nr_registro: '2' } },
          ] } });
        case '00018':
          return send({ resultados: { itens: [{ item: { cd_cadastro: '1', cd_item: '1111111', qt_minima: '5', qt_maxima: '6', 'vl_preco ': '1.037,50', 'vl_sugerido ': '1.489,90' } }] } });
        case '00007':
          return send({ resultados: { itens: [{ item: {
            cd_item: '1111111', descricao: 'CAPACETE TEXX G2 PRETO 58', cd_ean: '7890000000001', 'descrição_complem': 'Capacete fechado.\nCertificado Inmetro.',
            unidade: 'UN', NCM: '6506.10.00', peso_liquido: '1,350', peso_bruto: '1,800', largura_caixa: '30', altura_caixa: '28',
            complemento_caixa: '35', situacao: 'A', cd_ggrupo: '10', cd_grupo: '101', cd_sgrupo: '1011', nr_registro: '1',
          } }] } });
        case '00002':
          return send({ resultado: [{ pedido: { id_pedido: '32', mensagem: 'Saldo abaixo do limite de aviso' } }] });
        case '00008':
          return send({ resultado: [{ pedido: { id_pedido: '32', cd_situacao_venda: 'F', ds_situacao_venda: 'FATURADO', nr_nota_venda: '123', ch_acesso_nota_venda: '4125...', nr_nota_remessa: '' } }] });
        case '00009':
          return send({ erro: 'O pedido 123456 está cancelado.' });
        case '00015':
          return send({ resultados: { transportadores: [{ transportador: { cd_transportador: '17499', cnpj_transportador: '34028316000103', descricao: '17499-CORREIO' } }] } });
        case '00010':
        case '00003':
          return send({ resultado: 'ok' });
        default:
          return send({}, 404);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new LaquilaClient('token-de-teste', base);
const last = (m: string) => calls.filter((c) => c.url.endsWith(`/${m}`)).at(-1)!;

describe('LaquilaClient (formato de /docs)', () => {
  it('00017: uma consulta só, com filtro pagina=1 e 10000 itens, token na URL', async () => {
    expect(await client().stock()).toEqual([
      { cadastro: '1234567', sku: '1111111', qty: 46, qtyMax: null },
      { cadastro: '1234567', sku: '2222222', qty: 0, qtyMax: 3 },
    ]);
    const c = last('00017');
    expect(c.url).toBe('/token-de-teste/00017');
    expect(c.body.filtro).toMatchObject({ token: 'token-de-teste', cnpj_empresa: '03902443000166', pagina: '1', itensporpagina: '10000' });
  });

  it('00018: lê preço com vírgula decimal e espaço sobrando no nome do campo', async () => {
    const pages = [];
    for await (const p of client().prices()) pages.push(p);
    expect(pages.flat()[0]).toMatchObject({ sku: '1111111', cost: 1037.5, suggested: 1489.9, qtyMin: 5, qtyMax: 6 });
    expect(last('00018').body).toHaveProperty('filtro');
  });

  it('00007: converte os dados cadastrais', async () => {
    const item = await client().item('1111111');
    expect(item).toMatchObject({
      sku: '1111111', title: 'CAPACETE TEXX G2 PRETO 58', gtin: '7890000000001', ncm: '65061000',
      weightNetKg: 1.35, weightGrossKg: 1.8, widthCm: 30, heightCm: 28, lengthCm: 35, active: true,
    });
    expect(item?.description).toContain('Inmetro');
    expect(last('00007').body.filtro.cd_item).toBe('1111111');
  });

  it('00002: transmite no formato novo e lê id_pedido e o aviso de saldo', async () => {
    const res = await client().createOrder({
      cpfCnpj: '123.456.789-09', nome: 'Fulano', email: 'f@x.com', celular: '(41) 99999-0000',
      itens: [{ sku: '1100049', qty: 2, unitPrice: 15 }],
    });
    expect(res).toMatchObject({ id: '32', warning: 'Saldo abaixo do limite de aviso' });
    const sent = last('00002').body.pedido;
    expect(sent).toMatchObject({ cpf_cnpj: '12345678909', nr_celular: '41999990000', cd_transportador: '17499' });
    expect(sent.itens).toEqual([{ cd_item: '1100049', qt_pedida: '2', vl_unitario: '15.00' }]);
    expect(sent).not.toHaveProperty('nr_pedido');
  });

  it('00008: lê status da venda e da remessa', async () => {
    const st = await client().order('32');
    expect(st).toMatchObject({ id: '32', vendaSituacao: 'F', vendaSituacaoDesc: 'FATURADO', notaVenda: '123', notaRemessa: null });
  });

  it('00009: usa a chave "dados" e transforma {"erro"} em exceção', async () => {
    await expect(client().cancelOrder('123456', 'Cliente desistiu da compra')).rejects.toThrow(/está cancelado/);
    expect(last('00009').body.dados).toMatchObject({ id_pedido: '123456', motivo_cancelamento: 'Cliente desistiu da compra' });
  });

  it('exige motivo de cancelamento com 10+ caracteres', async () => {
    await expect(client().cancelOrder('1', 'curto')).rejects.toThrow(/10\+/);
  });

  it('00003 e 00010: enviam XML e etiqueta em Base64 na chave "dados"', async () => {
    await client().sendInvoiceXml('32', '<nfeProc/>', '41250000000000000000550010000001231000001234');
    expect(last('00003').body.dados).toMatchObject({ id_pedido: '32', xml: Buffer.from('<nfeProc/>').toString('base64'), nm_arquivo: '41250000000000000000550010000001231000001234.xml' });
    await client().sendLabel('32', { base64: 'JVBERi0x', fileName: 'etiqueta.pdf' });
    expect(last('00010').body.dados).toMatchObject({ id_pedido: '32', arquivo: 'JVBERi0x', nm_arquivo: 'etiqueta.pdf' });
  });

  it('00015: lista transportadoras', async () => {
    expect(await client().carriers()).toEqual([{ code: '17499', cnpj: '34028316000103', name: '17499-CORREIO' }]);
  });
});

describe('utilitários Laquila', () => {
  it('extractItems aceita lista simples', () => {
    expect(extractItems([{ cd_item: '1' }])).toEqual([{ cd_item: '1' }]);
  });
  it('field ignora espaços e caixa', () => {
    expect(field({ 'VL_PRECO ': 1 }, 'vl_preco')).toBe(1);
  });
  it('num entende vírgula decimal e milhar', () => {
    expect(num('1.234,56')).toBe(1234.56);
    expect(num('37,5')).toBe(37.5);
    expect(num('37.50')).toBe(37.5);
    expect(num('')).toBeNull();
  });
  it('extractOrderId procura em profundidade', () => {
    expect(extractOrderId({ retorno: { dados: { nr_pedido: 'A1' } } })).toBe('A1');
    expect(extractOrderId({ ok: true })).toBeNull();
  });
});

describe('Shopify', () => {
  it('valida a assinatura do webhook', () => {
    const body = Buffer.from('{"id":1}');
    const sig = createHmac('sha256', 'segredo-de-teste').update(body).digest('base64');
    expect(verifyWebhook(body, sig)).toBe(true);
    expect(verifyWebhook(body, 'errado')).toBe(false);
    expect(verifyWebhook(body, undefined)).toBe(false);
  });
  it('monta o productSet como rascunho, com SKU, custo e estoque', () => {
    const input = buildProductSetInput({ sku: 'ABC 123', title: 'Capacete', price: 399.9, cost: 200, quantity: 4 }, 'gid://shopify/Location/1');
    expect(input.handle).toBe(handleForSku('ABC 123'));
    expect(input.handle).toBe('laquila-abc-123');
    expect(input.status).toBe('DRAFT');
    expect(input.variants[0]).toMatchObject({
      sku: 'ABC 123', price: '399.90', inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true, cost: '200.00' },
      inventoryQuantities: [{ locationId: 'gid://shopify/Location/1', name: 'available', quantity: 4 }],
    });
  });
});

describe('Bling e pedidos', () => {
  it('monta o produto do Bling com NCM e imagens', () => {
    const p = toBlingProduct({ sku: '1', nome: 'X', preco: 10, ncm: '87149990', imagens: ['https://img/1.jpg'] });
    expect(p).toMatchObject({ codigo: '1', tipo: 'P', formato: 'S', tributacao: { ncm: '87149990' } });
    expect(p.midia?.imagens.externas).toEqual([{ link: 'https://img/1.jpg' }]);
  });
  it('acha o CPF nos atributos do pedido', () => {
    expect(findDocument({ note_attributes: [{ name: 'CPF', value: '123.456.789-09' }] })).toBe('12345678909');
    expect(findDocument({ billing_address: { company: '12.345.678/0001-90' } })).toBe('12345678000190');
    expect(findDocument({})).toBe('');
  });
  it('extrai o número do endereço', () => {
    expect(extractNumber('Rua das Flores, 123')).toBe('123');
    expect(extractNumber('Rua sem número')).toBe('S/N');
  });
});

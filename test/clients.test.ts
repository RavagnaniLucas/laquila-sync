import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LaquilaClient, extractItems, extractOrderId, field } from '../src/clients/laquila.js';
import { buildProductSetInput, handleForSku, verifyWebhook } from '../src/clients/shopify.js';
import { toBlingProduct } from '../src/clients/bling.js';
import { extractNumber, findDocument } from '../src/jobs/orders.js';

// Servidor falso da Laquila, com as respostas dos exemplos do PDF.
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
      if (req.url!.endsWith('/00017')) {
        const page = Number(body.pedido.pagina);
        const items = page === 1
          ? [{ item: { cd_cadastro: '1234567', cd_item: '1111111', qt_saldo: '46', qt_maxima: '', nr_registro: '1' } },
             { item: { cd_cadastro: '1234567', cd_item: '2222222', qt_saldo: '0', qt_maxima: '3', nr_registro: '2' } }]
          : [];
        return res.end(JSON.stringify({ resultados: { itens: items } }));
      }
      if (req.url!.endsWith('/00018')) {
        // O PDF traz "vl_preco " e "vl_sugerido " com espaço no fim: o cliente precisa tolerar.
        return res.end(JSON.stringify({ resultados: { itens: [{ item: { cd_cadastro: '1', cd_item: '1111111', qt_minima: '5', qt_maxima: '6', 'vl_preco ': '37.50', 'vl_sugerido ': '89.90' } }] } }));
      }
      if (req.url!.endsWith('/00009')) return res.end(JSON.stringify({ erro: 'O pedido 123456 está cancelado.' }));
      if (req.url!.endsWith('/00002')) return res.end(JSON.stringify({ pedido: { id_pedido: 98765 } }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('LaquilaClient', () => {
  it('lê o saldo paginado (00017) com o token na URL', async () => {
    const client = new LaquilaClient('token-de-teste', base);
    const pages = [];
    for await (const p of client.stock(2)) pages.push(p);
    expect(pages.flat()).toEqual([
      { cadastro: '1234567', sku: '1111111', qty: 46, qtyMax: null },
      { cadastro: '1234567', sku: '2222222', qty: 0, qtyMax: 3 },
    ]);
    expect(calls[0]!.url).toBe('/token-de-teste/00017');
    expect(calls[0]!.body.pedido.cnpj_empresa).toBe('03902443000166');
  });

  it('lê preço mesmo com espaço sobrando no nome do campo (00018)', async () => {
    const client = new LaquilaClient('token-de-teste', base);
    const pages = [];
    for await (const p of client.prices()) pages.push(p);
    expect(pages.flat()[0]).toMatchObject({ sku: '1111111', cost: 37.5, suggested: 89.9, qtyMin: 5, qtyMax: 6 });
  });

  it('transforma {"erro": ...} em exceção', async () => {
    const client = new LaquilaClient('token-de-teste', base);
    await expect(client.cancelOrder('123456', 'Cliente desistiu da compra')).rejects.toThrow(/está cancelado/);
  });

  it('exige motivo de cancelamento com 10+ caracteres', async () => {
    await expect(new LaquilaClient('t', base).cancelOrder('1', 'curto')).rejects.toThrow(/10\+/);
  });

  it('transmite pedido no formato novo do 00002', async () => {
    const res = await new LaquilaClient('token-de-teste', base).createOrder({
      cpfCnpj: '123.456.789-09', nome: 'Fulano', email: 'f@x.com', celular: '(41) 99999-0000',
      itens: [{ sku: '1100049', qty: 2, unitPrice: 15 }],
    });
    expect(res.id).toBe('98765');
    const sent = calls.at(-1)!.body.pedido;
    expect(sent).toMatchObject({ cpf_cnpj: '12345678909', nr_celular: '41999990000', cd_transportador: '17499' });
    expect(sent.itens).toEqual([{ cd_item: '1100049', qt_pedida: '2.00', vl_unitario: '15.00' }]);
    expect(sent).not.toHaveProperty('nr_pedido');
  });
});

describe('utilitários Laquila', () => {
  it('extractItems aceita lista simples', () => {
    expect(extractItems([{ cd_item: '1' }])).toEqual([{ cd_item: '1' }]);
  });
  it('field ignora espaços e caixa', () => {
    expect(field({ 'VL_PRECO ': 1 }, 'vl_preco')).toBe(1);
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

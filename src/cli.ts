import { sql } from './lib/db.js';
import { syncQueue, connection } from './lib/queue.js';
import { LaquilaClient } from './clients/laquila.js';
import * as bling from './clients/bling.js';
import * as shopify from './clients/shopify.js';

/**
 * Comandos de teste e operação. Uso dentro da VPS:
 *   docker compose run --rm app npm run cli -- <comando> [args]
 * Os comandos de leitura não alteram nada. Os de escrita dizem o que vão criar.
 */
const [cmd, ...args] = process.argv.slice(2);

const TEST_SKU = 'TESTE-LAQUILA-0001';

const commands: Record<string, { help: string; run: () => Promise<unknown> }> = {
  'shopify:loja': { help: 'Confere o acesso à Shopify (leitura)', run: () => shopify.gql(`{ shop { name myshopifyDomain plan { publicDisplayName } } }`) },
  'shopify:locais': { help: 'Lista os locais de estoque para escolher o SHOPIFY_LOCATION_ID (leitura)', run: () => shopify.listLocations() },
  'shopify:webhooks': { help: 'Registra os webhooks de pedido pago e cancelado (escrita)', run: () => shopify.registerWebhooks() },
  'shopify:produto-teste': {
    help: `Cria um produto RASCUNHO de teste (${TEST_SKU}), invisível para clientes (escrita)`,
    run: () =>
      shopify.upsertProduct({
        sku: TEST_SKU, title: 'TESTE integração Laquila (não publicar)', descriptionHtml: '<p>Produto de teste da integração.</p>',
        vendor: 'TESTE', price: 99.9, quantity: 0, status: 'DRAFT',
      }),
  },
  'bling:depositos': { help: 'Lista depósitos para escolher o BLING_DEPOSITO_ID (leitura)', run: () => bling.listDeposits() },
  'bling:produto-teste': {
    help: `Cria ou atualiza o produto de teste ${TEST_SKU} no Bling, situação Ativo, sem estoque (escrita)`,
    run: () => bling.upsertProduct({ sku: TEST_SKU, nome: 'TESTE integração Laquila (não vender)', preco: 99.9 }),
  },
  'laquila:saldo': {
    help: 'Mostra 5 itens do saldo (leitura; conta 1 das 3 consultas por hora do 00017)',
    run: async () => (await new LaquilaClient().stock()).slice(0, 5),
  },
  'laquila:preco': {
    help: 'Mostra os 5 primeiros itens de preço (leitura)',
    run: async () => {
      for await (const page of new LaquilaClient().prices(5)) return page;
    },
  },
  'laquila:item': { help: 'Dados cadastrais (00007) de um SKU (leitura)', run: () => new LaquilaClient().item(args[0] ?? '') },
  'laquila:marca': {
    help: 'Primeiros 10 itens de uma marca pelo 00007, ex.: laquila:marca TEXX (leitura)',
    run: async () => {
      for await (const page of new LaquilaClient().items({ ds_marca: args[0] ?? '' }, 10)) return page.map(({ raw, ...i }) => i);
    },
  },
  'laquila:transportadoras': { help: 'Lista códigos de transportadora (00015, leitura)', run: () => new LaquilaClient().carriers() },
  'laquila:limite': { help: 'Limite/saldo financeiro (00004, leitura; 6 por hora)', run: () => new LaquilaClient().credit() },
  'laquila:pedido': { help: 'Status de um pedido na Laquila (00008, leitura)', run: () => new LaquilaClient().order(args[0] ?? '') },
  'sync:agora': { help: 'Enfileira stock | price | items | publish', run: () => syncQueue.add(args[0] ?? 'stock', {}) },
};

async function main() {
  const c = cmd ? commands[cmd] : undefined;
  if (!c) {
    console.log('Comandos:\n' + Object.entries(commands).map(([k, v]) => `  ${k.padEnd(24)} ${v.help}`).join('\n'));
    return;
  }
  console.log(JSON.stringify(await c.run(), null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
    connection.disconnect();
  });

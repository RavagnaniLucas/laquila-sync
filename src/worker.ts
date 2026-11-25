import { Worker } from 'bullmq';
import { config } from './config.js';
import { sql } from './lib/db.js';
import { logger } from './lib/logger.js';
import { connection, enqueueOrder, ordersQueue, syncQueue } from './lib/queue.js';
import { publishCatalog, syncPrices, syncStock } from './jobs/catalog.js';
import { advanceOrder, type OrderStatus } from './jobs/orders.js';

const WAITING: OrderStatus[] = ['received', 'bling_created', 'laquila_sent', 'laquila_invoiced', 'nfe_issued', 'label_sent', 'shipped'];
const FINAL: OrderStatus[] = ['fulfilled', 'cancelled', 'error'];

async function main() {
  // O banco não é alterado aqui: migrações rodam só com `npm run migrate`, depois de aprovadas.
  const [check] = await sql<{ exists: boolean }[]>`select to_regclass('public.orders') is not null as exists`;
  if (!check?.exists) throw new Error('Banco sem tabelas: rode as migrações aprovadas com `docker compose run --rm app npm run migrate`');

  // Agendamentos. Jobs da Laquila só rodam quando ela estiver ligada.
  if (config.LAQUILA_ENABLED) {
    await syncQueue.upsertJobScheduler('stock', { pattern: config.CRON_STOCK }, { name: 'stock' });
    await syncQueue.upsertJobScheduler('price', { pattern: config.CRON_PRICE }, { name: 'price' });
  } else {
    await syncQueue.removeJobScheduler('stock');
    await syncQueue.removeJobScheduler('price');
    logger.warn('Laquila desligada: sync de estoque e preço não agendado');
  }
  await syncQueue.upsertJobScheduler('orders-sweep', { pattern: config.CRON_ORDERS_STATUS }, { name: 'orders-sweep' });

  new Worker(
    'sync',
    async (job) => {
      switch (job.name) {
        case 'stock': return syncStock();
        case 'price': return syncPrices();
        case 'publish': return publishCatalog(job.data?.sku);
        case 'orders-sweep': {
          // Reavalia pedidos parados em etapas que dependem de terceiros.
          const rows = await sql<{ shopify_order_id: string }[]>`
            select shopify_order_id from orders where status in ${sql(WAITING)} and attempts < 20`;
          for (const r of rows) await enqueueOrder(r.shopify_order_id);
          return { enqueued: rows.length };
        }
      }
    },
    { connection, concurrency: 1 }, // um sync por vez: respeita limites das APIs
  );

  new Worker(
    'orders',
    async (job) => {
      const id = job.data.id as string;
      // Avança várias etapas seguidas enquanto houver progresso.
      let prev: OrderStatus | null = null;
      let cur = await advanceOrder(id);
      while (cur !== prev && !FINAL.includes(cur)) {
        prev = cur;
        cur = await advanceOrder(id);
      }
      return cur;
    },
    { connection, concurrency: 2 },
  );

  logger.info('worker no ar');
}

main().catch((err) => {
  logger.error(err, 'worker caiu');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await Promise.allSettled([syncQueue.close(), ordersQueue.close(), sql.end()]);
    connection.disconnect();
    process.exit(0);
  });
}

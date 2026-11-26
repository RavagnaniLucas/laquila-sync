import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { sql } from './lib/db.js';
import { logger } from './lib/logger.js';
import { enqueueOrder, syncQueue } from './lib/queue.js';
import { blingAuthorizeUrl, consumeState, exchangeBlingCode } from './clients/bling.js';
import { verifyWebhook } from './clients/shopify.js';
import { LaquilaClient } from './clients/laquila.js';
import { cancelOrder, ingestShopifyOrder } from './jobs/orders.js';

const app = Fastify({ loggerInstance: logger, bodyLimit: 5 * 1024 * 1024, trustProxy: true });

// Webhooks precisam do corpo bruto para validar a assinatura.
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

app.get('/health', async () => {
  await sql`select 1`;
  return { ok: true, laquila: config.LAQUILA_ENABLED, bling: config.BLING_ENABLED, shopify: config.SHOPIFY_ENABLED };
});

// ---------- Bling: conexão OAuth (feita uma vez, no navegador) ----------
app.get('/bling/conectar', async (req, reply) => {
  if (!isAdmin(req.query as any)) return reply.code(401).send('Use /bling/conectar?chave=<ADMIN_TOKEN>');
  return reply.redirect(blingAuthorizeUrl());
});

app.get('/bling/callback', async (req, reply) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || !consumeState(state)) return reply.code(400).send('Link expirado. Comece de novo em /bling/conectar');
  await exchangeBlingCode(code);
  return reply.type('text/html').send('<h2>Bling conectado.</h2><p>Pode fechar esta aba.</p>');
});

// ---------- Shopify: webhooks ----------
async function shopifyWebhook(req: any, reply: any, handler: (payload: any) => Promise<void>) {
  const raw = req.body as Buffer;
  if (!verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'])) return reply.code(401).send();
  const webhookId = String(req.headers['x-shopify-webhook-id'] ?? '');
  const topic = String(req.headers['x-shopify-topic'] ?? '');
  if (webhookId) {
    const seen = await sql`select 1 from webhook_receipts where id = ${webhookId}`;
    if (seen.length) return reply.code(200).send(); // já processado
  }
  // Responde rápido (a Shopify espera até 5 s) e processa na fila. Só marca como recebido
  // depois de dar certo: se falhar, a Shopify reenvia e tentamos de novo.
  await handler(JSON.parse(raw.toString('utf8')));
  if (webhookId) await sql`insert into webhook_receipts (id, topic) values (${webhookId}, ${topic}) on conflict do nothing`;
  return reply.code(200).send();
}

app.post('/webhooks/shopify/orders-paid', (req, reply) =>
  shopifyWebhook(req, reply, async (payload) => {
    const id = await ingestShopifyOrder(payload);
    if (id) await enqueueOrder(id);
  }),
);

app.post('/webhooks/shopify/orders-cancelled', (req, reply) => shopifyWebhook(req, reply, (payload) => cancelOrder(payload)));

// ---------- Rotas internas (header x-admin-token) ----------
app.register(async (admin) => {
  admin.addHook('onRequest', async (req, reply) => {
    if (!isAdmin({ chave: req.headers['x-admin-token'] as string })) return reply.code(401).send();
  });

  admin.get('/admin/pedidos', async () =>
    sql`select shopify_order_name, status, last_error, laquila_order_id, tracking_code, updated_at
        from orders order by created_at desc limit 100`,
  );

  admin.post('/admin/pedidos/:id/reprocessar', async (req) => {
    const id = decodeURIComponent((req.params as any).id);
    await enqueueOrder(id);
    return { ok: true };
  });

  // Libera a trava de transmissão depois de conferir no painel da Laquila que o pedido NÃO entrou.
  admin.post('/admin/pedidos/:id/liberar-laquila', async (req) => {
    const id = decodeURIComponent((req.params as any).id);
    await sql`update orders set laquila_send_lock = null where shopify_order_id = ${id} and laquila_order_id is null`;
    await enqueueOrder(id);
    return { ok: true };
  });

  // Envia a etiqueta (arquivo em Base64, normalmente PDF) à Laquila pelo 00010 e grava o rastreio.
  admin.post('/admin/pedidos/:id/etiqueta', async (req, reply) => {
    const id = decodeURIComponent((req.params as any).id);
    const body = JSON.parse(String(req.body ?? '{}')) as { base64?: string; nomeArquivo?: string; rastreio?: string; transportadora?: string };
    if (!body.base64 || !body.rastreio) return reply.code(400).send({ erro: 'Envie { base64, rastreio, nomeArquivo?, transportadora? }' });
    const [o] = await sql<{ laquila_order_id: string | null; status: string; shopify_order_name: string }[]>`
      select laquila_order_id, status, shopify_order_name from orders where shopify_order_id = ${id}`;
    if (!o?.laquila_order_id || o.status !== 'xml_sent') return reply.code(409).send({ erro: 'Pedido não está aguardando etiqueta' });
    const fileName = body.nomeArquivo ?? `etiqueta-${o.shopify_order_name.replace('#', '')}.pdf`;
    await new LaquilaClient().sendLabel(o.laquila_order_id, { base64: body.base64, fileName });
    await sql`update orders set status = 'label_sent', label_file = ${fileName}, tracking_code = ${body.rastreio},
      tracking_company = ${body.transportadora ?? 'Correios'}, updated_at = now() where shopify_order_id = ${id}`;
    await enqueueOrder(id);
    return { ok: true };
  });

  admin.post('/admin/sync/:job', async (req, reply) => {
    const job = (req.params as any).job as string;
    if (!['stock', 'price', 'publish', 'items'].includes(job)) return reply.code(400).send();
    await syncQueue.add(job, {});
    return { ok: true, job };
  });

  admin.get('/admin/sync', async () => sql`select job, started_at, finished_at, ok, stats, error from sync_runs order by id desc limit 50`);
});

function isAdmin(q: { chave?: string }): boolean {
  const given = Buffer.from(String(q?.chave ?? ''));
  const expected = Buffer.from(config.ADMIN_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  logger.error(err);
  process.exit(1);
});

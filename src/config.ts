import { z } from 'zod';

// Todas as chaves vêm do .env da VPS. Nada de segredo no código ou no git.
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url(), // ex.: https://sync.sualoja.com.br
  ADMIN_TOKEN: z.string().min(24), // protege as rotas internas (/admin/*)

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://redis:6379'),

  // Laquila
  LAQUILA_BASE_URL: z.string().url().default('https://api-dropshipping.laquila.com.br'),
  LAQUILA_TOKEN: z.string().optional(),
  LAQUILA_CNPJ_EMPRESA: z.string().default('03902443000166'),
  LAQUILA_CPF_CNPJ_CONSULTA: z.string().optional(),
  LAQUILA_CD_TRANSPORTADOR: z.string().optional(),
  LAQUILA_ENABLED: bool(false), // só liga quando o token chegar

  // Bling v3
  BLING_CLIENT_ID: z.string().optional(),
  BLING_CLIENT_SECRET: z.string().optional(),
  BLING_DEPOSITO_ID: z.coerce.number().optional(),
  BLING_ENABLED: bool(false),

  // Shopify (app do Dev Dashboard, client credentials)
  SHOPIFY_SHOP: z.string().optional(), // loja.myshopify.com
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2026-10'),
  SHOPIFY_LOCATION_ID: z.string().optional(), // gid://shopify/Location/...
  SHOPIFY_ENABLED: bool(false),

  // Regras de negócio
  PRICE_MARKUP: z.coerce.number().default(1.8), // preço = custo × markup
  PRICE_MIN_MARGIN: z.coerce.number().default(0.25), // margem mínima sobre o preço de venda
  PRICE_FIXED_COST: z.coerce.number().default(8), // R$ 8 por pedido da Laquila
  PRICE_ENDING: z.coerce.number().default(0.9), // termina em ,90
  MAP_BRANDS: z.string().default('TEXX,HJC'), // marcas com preço mínimo = sugerido
  STOCK_SAFETY: z.coerce.number().default(2), // mostra 0 quando a Laquila tem <= isso
  STOCK_MAX_SHOWN: z.coerce.number().default(50),

  // Agendamentos (cron)
  // A Laquila aceita só 3 consultas de saldo (00017) por hora: a cada 30 min usa 2 e sobra 1.
  CRON_STOCK: z.string().default('*/30 * * * *'),
  CRON_PRICE: z.string().default('0 */6 * * *'),
  CRON_ITEMS: z.string().default('30 4 * * *'), // cadastro (00007) uma vez por dia, de madrugada
  CRON_ORDERS_STATUS: z.string().default('*/15 * * * *'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida no .env:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig(process.env.NODE_ENV === 'test' ? { ...testDefaults(), ...process.env } : process.env);

function testDefaults(): NodeJS.ProcessEnv {
  return {
    PUBLIC_URL: 'http://localhost:3000',
    ADMIN_TOKEN: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test@localhost/test',
  };
}

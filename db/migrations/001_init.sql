-- Produtos da Laquila e o vínculo com Bling e Shopify
create table products (
  sku              text primary key,            -- cd_item da Laquila
  laquila_cadastro text,                        -- cd_cadastro
  title            text,
  description_html text,
  brand            text,
  category         text,
  ncm              text,
  gtin             text,
  weight_kg        numeric(10,3),
  images           jsonb not null default '[]', -- lista de URLs
  raw              jsonb,                       -- última resposta bruta da Laquila (00007)
  laquila_qty      integer,
  qty_max          integer,
  qty_min          integer,
  cost             numeric(12,2),               -- vl_preco
  suggested        numeric(12,2),               -- vl_sugerido
  price            numeric(12,2),               -- preço de venda calculado
  compare_at       numeric(12,2),
  shown_qty        integer,
  enabled          boolean not null default false, -- publicar na loja?
  bling_id         bigint,
  shopify_product_id text,
  shopify_variant_id text,
  shopify_inventory_item_id text,
  synced_stock_at  timestamptz,
  synced_price_at  timestamptz,
  updated_at       timestamptz not null default now()
);
create index products_enabled_idx on products (enabled) where enabled;

-- Tokens OAuth (Bling). Fica no banco porque o refresh token roda a cada renovação.
create table oauth_tokens (
  provider       text primary key,
  access_token   text not null,
  refresh_token  text,
  expires_at     timestamptz not null,
  updated_at     timestamptz not null default now()
);

-- Pedidos: uma linha por pedido da Shopify, com o estado de cada etapa
create table orders (
  shopify_order_id   text primary key,
  shopify_order_name text not null,             -- ex.: #1001
  status             text not null default 'received',
  -- received → bling_created → laquila_sent → laquila_invoiced → nfe_issued
  -- → xml_sent → label_sent → shipped → fulfilled | cancelled | error | on_hold
  customer           jsonb not null,
  items              jsonb not null,
  shipping           jsonb,
  total              numeric(12,2),
  bling_order_id     bigint,
  bling_nfe_id       bigint,
  laquila_order_id   text,
  laquila_send_lock  timestamptz,               -- evita transmitir duas vezes (R$ 8 por pedido)
  tracking_code      text,
  tracking_company   text,
  last_error         text,
  attempts           integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index orders_status_idx on orders (status);

create table order_events (
  id               bigserial primary key,
  shopify_order_id text not null references orders(shopify_order_id),
  kind             text not null,
  detail           jsonb,
  created_at       timestamptz not null default now()
);

-- Histórico das rodadas de sincronização
create table sync_runs (
  id          bigserial primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb,
  error       text
);

-- Webhooks já processados (a Shopify pode reenviar o mesmo)
create table webhook_receipts (
  id          text primary key,
  topic       text not null,
  received_at timestamptz not null default now()
);

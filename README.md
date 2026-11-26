# laquila-sync

Serviço que liga o dropshipping da **Laquila** ao **Bling** (fiscal e NF-e) e à **Shopify** (catálogo, preço, estoque e pedidos). Roda na sua VPS com Docker.

```
Laquila ──(saldo, preço, notas)──► serviço na VPS ──► Bling  (cadastro fiscal, pedido, NF-e)
        ◄──(pedido, XML, etiqueta)──              ──► Shopify (produto, preço, estoque, rastreio)
```

## O que já funciona e o que espera a Laquila

| Parte | Situação |
| --- | --- |
| Regras de preço (markup, margem mínima, ,90, Texx/HJC ≥ sugerido) | Pronto e testado |
| Estoque exibido (margem de segurança, teto, máximo por pedido) | Pronto e testado |
| Shopify: token, produto (rascunho), preço, estoque, webhooks, envio com rastreio | Pronto, falta testar na sua loja |
| Bling v3: login OAuth, produto, estoque, contato, pedido de venda, gerar NF-e | Pronto, falta testar na sua conta |
| Pedido Shopify → Bling | Pronto, falta testar |
| Laquila, conforme a documentação oficial (/docs da API): saldo (00017), preço (00018), cadastro (00007), pedido (00002), status (00008), cancelamento (00009), XML (00003, 00012), etiqueta (00010), transportadoras (00015), limite (00004) | Pronto e testado contra uma Laquila falsa; **desligado** até chegar o token |
| Fotos e marca dos produtos | **A API não fornece.** A marca vem do filtro `ds_marca` na importação; fotos precisam de outra fonte |

Limites da Laquila respeitados: saldo (00017) no máximo 3 vezes por hora (agendado a cada 30 min) e limite financeiro (00004) 6 por hora. Um erro 429 não é repetido.

Tudo que depende da Laquila fica atrás de `LAQUILA_ENABLED=false`. Os pedidos param na etapa "Aguardando integração com a Laquila" sem erro. O mesmo vale para `BLING_ENABLED` e `SHOPIFY_ENABLED`.

## Fluxo do pedido

`received → bling_created → laquila_sent → laquila_invoiced → nfe_issued → xml_sent → label_sent → shipped → fulfilled`

- A transmissão à Laquila tem trava: o mesmo pedido **nunca** é enviado duas vezes (cada envio custa R$ 8 e debita o saldo). Se algo falhar no meio, confira no painel da Laquila e só então libere com `POST /admin/pedidos/:id/liberar-laquila`.
- A NF-e ao consumidor é **gerada** no Bling, mas a emissão fica com você até o contador validar o fluxo fiscal.
- Pedidos parados são reavaliados a cada 15 minutos.
- O rastreio é o da etiqueta que você gera: ao enviar a etiqueta (`POST /admin/pedidos/:id/etiqueta` com `base64` e `rastreio`), o serviço manda o arquivo à Laquila e, quando ela emite a nota de remessa, marca o pedido como enviado na Shopify.

## Segurança

- Segredos só no arquivo `.env` **dentro da VPS**. Nunca no git, nunca no chat.
- O token da Laquila vai na URL; os logs mascaram.
- Webhooks da Shopify são validados por HMAC e deduplicados.
- Rotas internas `/admin/*` exigem o cabeçalho `x-admin-token`.

## Publicação (ninguém publica à mão)

1. Mudanças entram por pull request. O CI roda typecheck, testes e build da imagem.
2. Seu **"Publique"** = você faz o merge na `main`.
3. O workflow **Deploy** espera sua aprovação no ambiente `production` do GitHub e roda `deploy/deploy.sh` na VPS.
4. O script guarda a versão anterior (ponto de volta), sobe a nova e confere `/health`. Se falhar, volta sozinho.
5. Para voltar a uma versão: Actions → Deploy → Run workflow → informe o SHA anterior (fica em `.deploy-history` na VPS).

O banco só muda pelo workflow **Migrar banco**, que faz um backup antes e também espera sua aprovação.

## Instalação na VPS (uma vez)

1. Rode `deploy/setup-vps.sh` como root na VPS. Ele instala Docker e firewall e mostra as chaves.
2. Cole a chave de leitura em *Settings → Deploy keys* do repositório (sem permissão de escrita).
3. Crie o ambiente `production` em *Settings → Environments*, com você como revisor obrigatório, e cadastre os segredos `VPS_HOST`, `VPS_USER`, `VPS_KNOWN_HOSTS` e `VPS_SSH_KEY`.
4. Na VPS: clone em `/opt/laquila-sync`, copie `.env.example` para `.env` e preencha.
5. Aponte o subdomínio (registro A) para o IP da VPS.
6. Rode o workflow **Migrar banco** e depois o **Deploy**.

## Conectar Shopify e Bling

**Shopify:** crie o app em https://dev.shopify.com/dashboard (mesma organização da loja), com os escopos `read_products, write_products, read_inventory, write_inventory, read_locations, read_orders, write_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders`. Instale na loja e copie Client ID e Client secret para o `.env`.

**Bling:** crie o aplicativo na área do integrador do Bling com o link de redirecionamento `https://SEU_SUBDOMINIO/bling/callback`. Copie Client ID e Client secret para o `.env`, ligue `BLING_ENABLED=true` e abra `https://SEU_SUBDOMINIO/bling/conectar?chave=SEU_ADMIN_TOKEN` para autorizar.

## Comandos de teste (na VPS)

```
docker compose run --rm app npm run cli                            # lista os comandos
docker compose run --rm app npm run cli -- shopify:loja            # confere o acesso (leitura)
docker compose run --rm app npm run cli -- shopify:locais          # leitura
docker compose run --rm app npm run cli -- shopify:produto-teste   # cria 1 rascunho de teste
docker compose run --rm app npm run cli -- bling:depositos         # leitura
docker compose run --rm app npm run cli -- bling:produto-teste     # cria 1 produto de teste
docker compose run --rm app npm run cli -- laquila:transportadoras # quando houver token
docker compose run --rm app npm run cli -- laquila:marca TEXX
docker compose run --rm app npm run cli -- laquila:item 1111111
```

## Desenvolvimento

```
npm ci
npm test          # testes (inclui uma Laquila falsa com as respostas do PDF)
npm run typecheck
```

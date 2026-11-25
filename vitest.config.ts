import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      NODE_ENV: 'test',
      LAQUILA_ENABLED: 'true',
      LAQUILA_TOKEN: 'token-de-teste',
      LAQUILA_CD_TRANSPORTADOR: '17499',
      SHOPIFY_CLIENT_SECRET: 'segredo-de-teste',
    },
  },
});

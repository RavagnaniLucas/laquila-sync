import pino from 'pino';
import { config } from '../config.js';

// Tokens e segredos nunca vão para o log, nem dentro de URLs.
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['*.token', '*.access_token', '*.refresh_token', '*.client_secret', 'headers.authorization', '*.headers["x-shopify-access-token"]'],
    censor: '[oculto]',
  },
});

/** Esconde o token da Laquila, que vai no caminho da URL. */
export function maskUrl(url: string): string {
  const token = config.LAQUILA_TOKEN;
  return token ? url.split(token).join('***') : url;
}

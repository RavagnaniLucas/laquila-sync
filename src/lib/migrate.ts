import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './db.js';
import { logger } from './logger.js';

// Aplica, em ordem, os arquivos db/migrations/*.sql ainda não aplicados.
const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

export async function migrate(): Promise<void> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    logger.info({ file }, 'migração aplicada');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => sql.end())
    .catch((err) => {
      logger.error(err, 'falha na migração');
      process.exit(1);
    });
}

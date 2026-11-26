#!/bin/sh
# Roda dentro do contêiner "backup". Faz um dump diário às 03:00 (horário do contêiner, UTC)
# e mantém só os 14 arquivos mais recentes em /backups.
set -eu
while true; do
  if [ "$(date +%H%M)" = "0300" ]; then
    file="/backups/laquila-$(date +%F).sql.gz"
    pg_dump -h postgres -U laquila laquila | gzip > "$file"
    echo "backup gravado: $file"
    ls -1t /backups/laquila-*.sql.gz | tail -n +15 | while read -r old; do
      rm -f -- "$old"
    done
    sleep 60
  fi
  sleep 30
done

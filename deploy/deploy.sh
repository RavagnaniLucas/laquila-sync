#!/usr/bin/env bash
# Publica uma versão na VPS e volta sozinho para a anterior se a saúde falhar.
# Uso (chamado pelo GitHub Actions): ./deploy/deploy.sh <sha>
set -euo pipefail
cd "$(dirname "$0")/.."

ref="${1:?informe o SHA}"
prev="$(git rev-parse HEAD)"
url="$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)"

echo "Versão atual (ponto de volta): $prev"
git fetch --depth 50 origin main
git checkout --detach "$ref"
docker compose up -d --build app worker

for i in $(seq 1 20); do
  if curl -fsS "$url/health" >/dev/null; then
    echo "$(date -Is) $prev -> $ref OK" >> .deploy-history
    echo "No ar: $ref"
    exit 0
  fi
  sleep 6
done

echo "Saúde falhou. Voltando para $prev"
git checkout --detach "$prev"
docker compose up -d --build app worker
echo "$(date -Is) $prev -> $ref FALHOU, voltou" >> .deploy-history
exit 1

#!/usr/bin/env bash
# Preparação única da VPS (Ubuntu 22.04/24.04). Rode como root:
#   curl -fsSL <link raw deste arquivo> -o setup-vps.sh && bash setup-vps.sh
# O que faz: instala Docker, cria o usuário "deploy", libera só as portas 22/80/443,
# cria a pasta /opt/laquila-sync e gera as chaves que o GitHub vai usar.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root (sudo -i)"; exit 1; fi

apt-get update -y
apt-get install -y ca-certificates curl git ufw unattended-upgrades

# Docker oficial
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Usuário que o GitHub Actions usa para publicar
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh

# Firewall: SSH, HTTP e HTTPS
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Atualizações de segurança automáticas
dpkg-reconfigure -f noninteractive unattended-upgrades

# 1) Chave que o GitHub Actions usa para entrar na VPS (publicar)
if [ ! -f /home/deploy/.ssh/actions ]; then
  sudo -u deploy ssh-keygen -t ed25519 -N '' -C 'github-actions' -f /home/deploy/.ssh/actions
  cat /home/deploy/.ssh/actions.pub >> /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
fi

# 2) Chave só de leitura para a VPS baixar o código do repositório privado
if [ ! -f /home/deploy/.ssh/repo ]; then
  sudo -u deploy ssh-keygen -t ed25519 -N '' -C 'vps-laquila-sync' -f /home/deploy/.ssh/repo
  sudo -u deploy tee /home/deploy/.ssh/config >/dev/null <<'CFG'
Host github.com
  IdentityFile ~/.ssh/repo
  IdentitiesOnly yes
CFG
fi

install -d -o deploy -g deploy /opt/laquila-sync

ip=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<MSG

============================================================
VPS pronta. IP público: $ip

PASSO A) Chave de leitura do repositório (cole como Deploy key, SEM marcar escrita):
$(cat /home/deploy/.ssh/repo.pub)

PASSO B) Segredos do GitHub Actions (Settings > Secrets and variables > Actions):
  VPS_HOST         = $ip
  VPS_USER         = deploy
  VPS_KNOWN_HOSTS  = (a linha abaixo)
$(ssh-keyscan -t ed25519 localhost 2>/dev/null | sed "s/^localhost/$ip/")
  VPS_SSH_KEY      = conteúdo do arquivo /home/deploy/.ssh/actions
                     (mostre com: cat /home/deploy/.ssh/actions  e cole direto no GitHub,
                      nunca no chat)

PASSO C) Depois disso:
  sudo -u deploy git clone git@github.com:RavagnaniLucas/laquila-sync.git /opt/laquila-sync
  cd /opt/laquila-sync && sudo -u deploy cp .env.example .env && sudo -u deploy nano .env
============================================================
MSG

# Hetzner deployment runbook

Deploys both `onchain-me-be` (this repo) and `onchain-me` (frontend) onto a
single Hetzner Cloud CX22 VPS. Builds happen on the server; reverse proxy
+ TLS is handled by Caddy with automatic Let's Encrypt certificates.

```
                  Internet :443
                       │
                  ┌────▼─────┐
                  │   Caddy  │  auto-TLS
                  └──┬────┬──┘
            ┌────────┘    └────────┐
            ▼                      ▼
     ┌────────────┐         ┌────────────┐
     │ api :3001  │         │  frontend  │
     │ (Fastify)  │         │  :3000     │
     └──┬─────┬───┘         └────────────┘
        │     │
        ▼     ▼
  ┌──────┐ ┌──────┐  ┌────────┐
  │Mongo │ │Redis │  │ worker │ (BullMQ, no public port)
  │ rs0  │ │      │  │        │
  └──────┘ └──────┘  └────────┘
```

---

## Prerequisites

- Hetzner Cloud account with an SSH key uploaded.
- Domain you control (`<DOMAIN>` below). Two A-records will point at the VPS:
  - `api.<DOMAIN>`
  - `app.<DOMAIN>`
- Local machine with `solana` CLI (used once to fund the mint authority).
- Optional: free Helius dev API key (only required for mainnet later).

---

## 1. Provision the VPS

1. In the [Hetzner Cloud Console](https://console.hetzner.cloud) create a new
   server: Ubuntu 24.04, type **CX22** (2 vCPU / 4 GB / 40 GB), Nuremberg or
   Helsinki, attach your SSH key. Take note of the IPv4.
2. In your DNS provider, create A-records pointing to that IPv4:
   - `api.<DOMAIN>` → `<IP>`
   - `app.<DOMAIN>` → `<IP>`
   - `<DOMAIN>` → `<IP>` (optional, redirects to `app.`)
3. Wait until DNS propagates: `dig +short api.<DOMAIN>` returns the IP.

---

## 2. Bootstrap the server (once)

SSH as `root@<IP>` and run:

```bash
# Create non-root deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# Firewall
apt update && apt install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# 4 GB swap (CX22 has only 4 GB RAM; next build can spike)
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf

# Docker (official repo)
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker deploy

# Re-login as deploy
exit
```

```bash
ssh deploy@<IP>
docker --version && docker compose version
```

---

## 3. Clone repos side-by-side

```bash
mkdir -p ~/projects && cd ~/projects
git clone -b develop git@github.com:Onchainme/onchain-me-be.git
git clone -b dev      git@github.com:Onchainme/onchain-me.git
```

The compose file expects this exact layout:

```
~/projects/
├── onchain-me-be/      ← this repo
└── onchain-me/         ← frontend
```

> If the deploy user does not have a GitHub SSH key, generate one
> (`ssh-keygen -t ed25519`) and add the public key as a Deploy Key (read-only)
> on each repo's GitHub Settings → Deploy keys.

---

## 4. Generate prod secrets

### 4.1 JWT, admin password

```bash
cd ~/projects/onchain-me-be
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
```

Generate values and write them into the file:

```bash
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=')"
echo "ADMIN_BASIC_AUTH=admin:$(openssl rand -base64 24 | tr -d '/+= ')"
echo "HELIUS_WEBHOOK_SECRET=$(openssl rand -hex 32)"
```

### 4.2 Mint authority keypair

```bash
# Install solana CLI on the server (you only need it for keygen + tree).
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

solana-keygen new -o ~/.config/solana/onchainme-prod.json --no-bip39-passphrase
solana-keygen pubkey ~/.config/solana/onchainme-prod.json
# -> 9Xyz... (record this; we'll fund it next)

# Encode the secret as base58 for MINT_AUTHORITY_PRIVATE_KEY:
node -e '
const fs=require("fs");
const bs58=require("bs58");
const enc=bs58.default?bs58.default.encode:bs58.encode;
const sk=Uint8Array.from(JSON.parse(fs.readFileSync("/home/deploy/.config/solana/onchainme-prod.json")));
process.stdout.write(enc(sk));
'
# (run inside any node project that has bs58 installed; or scp the file home and
#  encode locally — the value is what goes into MINT_AUTHORITY_PRIVATE_KEY.)
```

### 4.3 Fund the authority

On your **local** machine (where your funded devnet keypair lives):

```bash
solana transfer <PUBKEY_FROM_STEP_4.2> 0.8 \
  --url devnet \
  --allow-unfunded-recipient \
  --fee-payer ~/.config/solana/id.json
```

Verify on the server: `solana balance <PUBKEY> --url devnet` → 0.8 SOL.

### 4.4 Create the Merkle tree

```bash
cd ~/projects/onchain-me-be/packages/shared
SOLANA_RPC_URL=https://api.devnet.solana.com \
MINT_AUTHORITY_PRIVATE_KEY=<base58_from_4.2> \
node --import tsx scripts/create-tree.ts
# -> prints "MERKLE_TREE_ADDRESS=<pubkey>"
```

Write the output into `deploy/.env.production` as `MERKLE_TREE_ADDRESS=<pubkey>`.

> Don't have `tsx` available? Use the workspace one:
> `pnpm --filter @onchainme/shared exec tsx scripts/create-tree.ts`

### 4.5 Fill the rest of `.env.production`

Set `DOMAIN`, `CADDY_ACME_EMAIL`, `COOKIE_DOMAIN`, `FRONTEND_ORIGIN`,
`NEXT_PUBLIC_API_BASE_URL`, `METADATA_BASE_URL` to match your domain.

---

## 5. First deploy

```bash
cd ~/projects/onchain-me-be
docker compose -f deploy/docker-compose.prod.yml \
               --env-file deploy/.env.production \
               up -d --build
```

First build takes 5–10 minutes (frontend Next.js dominates).

Watch the logs while Caddy gets certificates and the Mongo replica set
initializes:

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f
```

Sync DB indexes (one-shot):

```bash
docker compose -f deploy/docker-compose.prod.yml exec api \
  node -e "require('./node_modules/@onchainme/shared/dist/db/connect.js').connectDb().then(()=>require('./node_modules/@onchainme/shared/dist/db/models.js')).then(m=>Promise.all(Object.values(m).filter(x=>x?.syncIndexes).map(x=>x.syncIndexes()))).then(()=>process.exit(0))"
```

> If that one-liner is too brittle, copy `packages/shared/src/db/ensure-indexes.ts`
> into the api image at build time and run it via `node`.

---

## 6. Verify

```bash
curl https://api.<DOMAIN>/api/v1/health
# -> {"ok":true,"db":"ok","redis":"ok"}

curl https://api.<DOMAIN>/api/v1/badges | jq '.items | length'
# -> 10

curl -I https://app.<DOMAIN>
# -> HTTP/2 200
```

Open `https://app.<DOMAIN>/edit` in a browser with Phantom (Devnet mode),
sign in, hit **Update inventory** to seed eligibility (dev endpoint must be
enabled — see "Switching off dev seed" below), mint a single badge, watch the
Solana Explorer link confirm.

---

## 7. Day-to-day operations

### Redeploy after a code change

```bash
cd ~/projects/onchain-me-be && git pull
cd ~/projects/onchain-me    && git pull
cd ~/projects/onchain-me-be
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
docker image prune -f
```

Total downtime: ~30 seconds while containers restart.

### Logs

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f api worker
docker compose -f deploy/docker-compose.prod.yml logs -f caddy
```

### Mongo backup (manual)

```bash
docker compose -f deploy/docker-compose.prod.yml exec mongo \
  mongodump --port 27017 --db onchainme \
  --out /data/db/backup-$(date +%F)
# Then scp it off the box:
docker compose cp mongo:/data/db/backup-$(date +%F) ./
```

### Switching off dev seed (mainnet readiness)

The `/api/v1/dev/seed-eligibility[+all]` routes only register when
`NODE_ENV=development`. On prod (NODE_ENV=production) they're absent, so the
worker scan must produce eligibility. For devnet alpha you can either:

- Keep `NODE_ENV=production` and seed eligibility manually via a one-off
  Mongo insert per badge, or
- Set `NODE_ENV=development` temporarily and use the dev endpoints (NOT
  recommended on a public URL — the seed routes have no admin auth).

For mainnet, set up Helius and run a real wallet scan.

### Promoting from devnet to mainnet

1. Generate a fresh mint authority keypair, fund with real SOL (~0.7 SOL for
   the tree, plus ~0.000005 SOL per mint).
2. Create a mainnet Merkle tree (rerun `scripts/create-tree.ts` with mainnet
   RPC + new keypair).
3. Update `.env.production`:
   - `SOLANA_CLUSTER=mainnet-beta`
   - `SOLANA_RPC_URL=<helius-mainnet-rpc>`
   - `HELIUS_API_KEY=<your-key>`
   - `MINT_AUTHORITY_PRIVATE_KEY=<new-base58>`
   - `MERKLE_TREE_ADDRESS=<new-pubkey>`
4. `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d`
   (no `--build` — env-only change).

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Caddy logs `acme: too many failed authorizations` | DNS not propagated yet | wait + retry; meanwhile uncomment `acme_ca staging` in `Caddyfile` |
| `api` container restarts in a loop | `MERKLE_TREE_ADDRESS` placeholder still set | fill it (step 4.4) and redeploy |
| `next build` killed (OOM) | swap not enabled | re-run step 2.3 |
| `mongo` healthcheck never goes green | `mongosh` script error during init | `docker compose exec mongo mongosh --port 27017 --eval "rs.status()"` to inspect |
| Frontend reads `http://localhost:3001` after deploy | the `NEXT_PUBLIC_*` arg wasn't passed at build time | rebuild with `--build` after fixing `.env.production` |

---

## 9. What's not in this runbook (yet)

- GitHub Actions CI/CD (build + push images, server pulls instead of building).
- Off-box Mongo backups (Hetzner Storage Box / S3).
- Sentry, log shipping (loki/grafana), uptime monitoring.
- Blue-green / zero-downtime deploys.

These can be layered on later without changing the topology described here.

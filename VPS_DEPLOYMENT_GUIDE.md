# BloomCart VPS Deployment Guide (Backend + PostgreSQL)

This guide is a production-focused, end-to-end runbook for deploying BloomCart backend on a VPS.

---

## 1) Architecture (Recommended)

- **VPS OS**: Ubuntu 22.04 LTS
- **Process manager**: PM2
- **Reverse proxy**: Nginx
- **TLS**: Let's Encrypt (Certbot)
- **Database**: PostgreSQL 16+
- **App runtime**: Node.js 20 LTS
- **Uploads**: Local disk (`server/uploads`) or object storage (recommended for scale)

---

## 2) Pre-Deployment Checklist

- Domain/subdomain ready (example: `api.yourdomain.com`)
- DNS A record points to VPS public IP
- SSH key access to VPS
- Local code pushed to remote Git repo
- PostgreSQL migration SQL/script ready
- `.env` values finalized for production

---

## 3) Initial VPS Setup

### 3.1 Create non-root deploy user

```bash
adduser deploy
usermod -aG sudo deploy
```

### 3.2 SSH hardening (recommended)

Edit `/etc/ssh/sshd_config`:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Restart SSH:

```bash
sudo systemctl restart ssh
```

### 3.3 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## 4) Install Runtime Dependencies

### 4.1 System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential nginx unzip
```

### 4.2 Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 4.3 PM2

```bash
sudo npm install -g pm2
pm2 -v
```

---

## 5) Install and Configure PostgreSQL

### 5.1 Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

### 5.2 Create DB and user

```bash
sudo -u postgres psql
```

In psql:

```sql
CREATE DATABASE bloomcart;
CREATE USER bloomcart WITH ENCRYPTED PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE bloomcart TO bloomcart;
\q
```

### 5.3 Optional: allow remote DB access (for DBeaver)

If you want to connect from your local machine:

1. Edit `postgresql.conf` (path may vary):
   - `/etc/postgresql/16/main/postgresql.conf`
   - set: `listen_addresses = '*'`

2. Edit `pg_hba.conf`:

```text
host    bloomcart    bloomcart    0.0.0.0/0    scram-sha-256
```

3. Restart PostgreSQL:

```bash
sudo systemctl restart postgresql
```

4. Open firewall DB port only if needed (restrict by source IP if possible):

```bash
sudo ufw allow 5432/tcp
```

Security recommendation: prefer SSH tunnel over opening `5432` publicly.

---

## 6) Deploy Application Code

### 6.1 Clone repository

```bash
cd /var/www
sudo mkdir -p bloomcart
sudo chown -R deploy:deploy /var/www/bloomcart
cd /var/www/bloomcart
git clone <YOUR_REPO_URL> .
```

### 6.2 Install server dependencies

```bash
cd server
npm ci --omit=dev
```

### 6.3 Create production `.env`

Create `server/.env`:

```env
PORT=3001
NODE_ENV=production
JWT_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
JWT_EXPIRES_IN=7d
DATABASE_URL=postgresql://bloomcart:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/bloomcart
```

Notes:
- Use `127.0.0.1` instead of `localhost` to avoid socket/driver mismatch edge-cases.
- Keep `.env` out of git.

---

## 7) Initialize Database Schema and Data

Choose one strategy:

### Option A: Fresh production schema

```bash
psql "postgresql://bloomcart:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/bloomcart" -f server/config/schema.sql
```

### Option B: Migrate existing SQLite data

```bash
cd server
node scripts/smart-migrate.js
```

Then validate:

```bash
psql "postgresql://bloomcart:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/bloomcart" -c "SELECT COUNT(*) FROM users;"
```

---

## 8) Start Backend with PM2

From `server` directory:

```bash
pm2 start server.js --name bloomcart-api
pm2 save
pm2 startup
```

Check logs:

```bash
pm2 logs bloomcart-api --lines 200
pm2 status
```

Health check:

```bash
curl -s http://127.0.0.1:3001/api/health
```

---

## 9) Configure Nginx Reverse Proxy

Create Nginx site:

```bash
sudo nano /etc/nginx/sites-available/bloomcart-api
```

Use:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/bloomcart-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 10) Enable HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

Verify auto-renew:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

---

## 11) App Configuration for Mobile Client

Update mobile app API base URL to:

```text
https://api.yourdomain.com/api
```

If using Expo:
- Store API base in environment config.
- Rebuild app if endpoint is compiled into bundle.

---

## 12) Production Operations

### 12.1 Deploy updates

```bash
cd /var/www/bloomcart
git pull
cd server
npm ci --omit=dev
pm2 restart bloomcart-api
pm2 logs bloomcart-api --lines 100
```

### 12.2 Backups (daily)

Create backup script `/usr/local/bin/bloomcart-backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%F-%H%M)
OUT="/var/backups/bloomcart-${TS}.sql"
pg_dump "postgresql://bloomcart:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/bloomcart" > "$OUT"
find /var/backups -name 'bloomcart-*.sql' -mtime +7 -delete
```

Make executable and schedule:

```bash
sudo chmod +x /usr/local/bin/bloomcart-backup.sh
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/bloomcart-backup.sh") | crontab -
```

### 12.3 Monitoring checks

- `pm2 status`
- `pm2 logs bloomcart-api`
- `sudo systemctl status nginx`
- `sudo systemctl status postgresql`
- `df -h` (disk)
- `free -m` (memory)

---

## 13) DBeaver Connection (Production)

Use these values in DBeaver:

- Host: VPS public IP or domain
- Port: 5432
- Database: bloomcart
- Username: bloomcart
- Password: your configured password
- SSL: disable initially (or configure TLS later)

If connection fails:
1. Check PostgreSQL listening: `sudo ss -tulpn | grep 5432`
2. Check `pg_hba.conf` rule for your IP
3. Check firewall (`ufw status`)
4. Test from VPS directly with `psql`
5. Prefer SSH tunnel in DBeaver for security

---

## 14) Zero-Downtime Rollback Plan

- Keep previous PM2 process definition and previous git tag.
- On failed deployment:

```bash
cd /var/www/bloomcart
git checkout <last-stable-tag>
cd server
npm ci --omit=dev
pm2 restart bloomcart-api
```

- Restore DB only if schema/data migration was applied and must be reverted.

---

## 15) Security Hardening Checklist

- Use strong random `JWT_SECRET`
- Restrict CORS origins in production
- Disable wildcard DB network access
- Rotate DB credentials periodically
- Enable fail2ban for SSH
- Keep OS and packages patched
- Store backups off-server (S3/Backblaze/etc.)

---

## 16) Current Project-Specific Note

Before deleting SQLite permanently, ensure runtime in `server/config/database.js` is fully switched to PostgreSQL and all routes are validated against PostgreSQL.

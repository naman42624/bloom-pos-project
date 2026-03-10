# BloomCart POS — Deployment Guide

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Server Deployment](#server-deployment)
3. [Mobile App Build & Deployment](#mobile-app-build--deployment)
4. [Environment Configuration](#environment-configuration)
5. [Database Considerations](#database-considerations)
6. [Security Checklist](#security-checklist)
7. [Monitoring & Maintenance](#monitoring--maintenance)

---

## Prerequisites

- **Node.js** >= 18.x
- **npm** or **yarn**
- **Expo CLI** (`npm install -g expo-cli`)
- **EAS CLI** for production builds (`npm install -g eas-cli`)
- A server/VPS for the backend (e.g., DigitalOcean, Railway, Render, AWS EC2)
- Apple Developer account (for iOS builds)
- Google Play Developer account (for Android builds)

---

## Server Deployment

### 1. Clone & Install

```bash
cd server
npm install
```

### 2. Create Environment File

Create `server/.env`:

```env
PORT=3001
NODE_ENV=production
JWT_SECRET=your-strong-random-secret-here-min-32-chars
JWT_EXPIRES_IN=7d
```

**Important:** Generate a strong JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Deploy Options

#### Option A: VPS (DigitalOcean, EC2, etc.)

```bash
# Install Node.js on server
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone repo, install deps
cd /opt/bloomcart
npm install --production

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name bloomcart-api
pm2 save
pm2 startup
```

#### Option B: Railway / Render (PaaS)

1. Push the `server/` directory to a Git repository
2. Connect to Railway or Render
3. Set environment variables in the dashboard
4. Deploy — the platform will run `npm start` automatically

#### Option C: Docker

Create `server/Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

```bash
docker build -t bloomcart-api .
docker run -d -p 3001:3001 --env-file .env bloomcart-api
```

### 4. Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name api.bloomcart.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 5. SSL Certificate

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.bloomcart.com
```

### 6. Uploads Directory

Ensure the `server/uploads/` directory exists and is writable:
```bash
mkdir -p uploads
chmod 755 uploads
```

For production, consider using cloud storage (S3, Cloudinary) instead of local file storage.

---

## Mobile App Build & Deployment

### 1. Update API URL

In `app/src/services/api.js`, change the server URL to your production server:

```javascript
const API_BASE = 'https://api.bloomcart.com/api';
const SOCKET_URL = 'https://api.bloomcart.com';
```

**Better approach — use environment config:**

Create `app/src/config/env.js`:
```javascript
import Constants from 'expo-constants';

const ENV = {
  development: {
    API_URL: 'http://192.168.29.160:3001/api',
    SOCKET_URL: 'http://192.168.29.160:3001',
  },
  production: {
    API_URL: 'https://api.bloomcart.com/api',
    SOCKET_URL: 'https://api.bloomcart.com',
  },
};

const getEnv = () => {
  const channel = Constants.expoConfig?.extra?.channel || 'development';
  return ENV[channel] || ENV.development;
};

export default getEnv();
```

### 2. Configure EAS Build

Create `app/eas.json`:
```json
{
  "cli": { "version": ">= 3.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal"
    },
    "production": {
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {}
  }
}
```

### 3. Build for Android

```bash
cd app
eas build --platform android --profile production
```

This generates an `.aab` (Android App Bundle) for Play Store submission.

For APK (direct install):
```bash
eas build --platform android --profile preview
```

### 4. Build for iOS

```bash
eas build --platform ios --profile production
```

Requires Apple Developer account credentials.

### 5. Submit to Stores

```bash
# Android (Google Play)
eas submit --platform android

# iOS (App Store)
eas submit --platform ios
```

### 6. Over-the-Air Updates

Add to `app/app.json` inside `expo`:
```json
"updates": {
  "url": "https://u.expo.dev/your-project-id"
},
"runtimeVersion": {
  "policy": "sdkVersion"
}
```

Push OTA updates:
```bash
eas update --branch production --message "Bug fix v1.0.1"
```

---

## Environment Configuration

### Server Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | Yes | `development` | Set to `production` for deployment |
| `JWT_SECRET` | **Yes** | None (will crash) | Secret key for JWT signing |
| `JWT_EXPIRES_IN` | No | `7d` | Token expiration time |

### App Configuration

| Config | Location | Description |
|--------|----------|-------------|
| API URL | `app/src/services/api.js` | Backend server URL |
| Socket URL | `app/src/services/api.js` | WebSocket server URL |
| App Name | `app/app.json` | Display name |
| Bundle ID | `app/app.json` | `com.bloomcart.pos` |

---

## Database Considerations

### Current Setup: SQLite
- File-based database at `server/database.sqlite`
- Uses WAL (Write-Ahead Logging) mode for better concurrent reads
- **Limitation:** Not suitable for horizontal scaling (multiple server instances)

### Production Recommendations

1. **Single Instance:** SQLite is fine for small-medium businesses with one server instance
2. **Scale-up:** Migrate to PostgreSQL or MySQL when:
   - You need multiple server instances
   - Database exceeds ~10GB
   - You need more complex querying
   - You need point-in-time recovery

### Backup Strategy

```bash
# Daily backup via cron
0 2 * * * cp /opt/bloomcart/server/database.sqlite /opt/bloomcart/backups/db-$(date +\%Y\%m\%d).sqlite

# Or use SQLite backup API
sqlite3 database.sqlite ".backup '/opt/bloomcart/backups/db-$(date +%Y%m%d).sqlite'"
```

---

## Security Checklist

- [ ] **JWT_SECRET** — Set a strong, unique secret (64+ chars)
- [ ] **CORS** — Restrict `origin` in `server.js` from `*` to your app's domain
- [ ] **HTTPS** — Always use SSL in production (nginx + certbot)
- [ ] **Helmet** — Already enabled (`helmet()` middleware)  
- [ ] **Rate Limiting** — Add `express-rate-limit` for API endpoints
- [ ] **File Uploads** — Validate file types, limit sizes (already configured: 5MB, JPEG/PNG/WebP)
- [ ] **Database Backups** — Set up automated daily backups
- [ ] **Logging** — Morgan logger is enabled; consider persistent log storage
- [ ] **Password Policy** — Enforce minimum password length
- [ ] **Remove Default Credentials** — Change all test accounts before going live

### Recommended: Add Rate Limiting

```bash
cd server
npm install express-rate-limit
```

In `server.js`:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);
```

---

## Monitoring & Maintenance

### Process Management (PM2)

```bash
# View logs
pm2 logs bloomcart-api

# Monitor
pm2 monit

# Restart
pm2 restart bloomcart-api

# View status
pm2 status
```

### Health Check Endpoint

Add to `server.js`:
```javascript
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
```

### Log Rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
```

### Update Process

1. Pull latest code
2. `npm install` in both `server/` and `app/`
3. Restart server: `pm2 restart bloomcart-api`
4. For app updates: `eas update` (OTA) or `eas build` (native changes)

---

## Quick Start (Development)

```bash
# Terminal 1: Start server
cd server
npm run dev

# Terminal 2: Start app
cd app
npx expo start
```

Access via:
- **iOS/Android:** Scan QR code from Expo Go
- **Web:** http://localhost:8081
- **API:** http://localhost:3001/api

# BloomCart POS — Production Deployment Guide

## Table of Contents
1. [Project Analysis](#1-full-project-analysis)
2. [Production Architecture](#2-production-architecture)
3. [Database Migration](#3-database-migration)
4. [Production Backend](#4-production-backend)
5. [Mobile App Changes](#5-mobile-app-changes)
6. [Performance & Scalability](#6-performance--scalability)
7. [Security Hardening](#7-security-hardening)
8. [Dockerization](#8-dockerization)
9. [Deployment Pipeline](#9-deployment-pipeline)
10. [Expo EAS Deployment](#10-expo-eas-deployment)
11. [CI/CD Pipeline](#11-cicd-pipeline)
12. [Final Project Structure](#12-final-project-structure)

---

## 1. FULL PROJECT ANALYSIS

### How the App Currently Works

BloomCart POS is a **flower shop management system** with:
- **React Native (Expo ~54)** mobile app for POS, inventory, deliveries, attendance
- **Express.js** backend API on port 3001
- **SQLite** (better-sqlite3) as the database in WAL mode
- **Socket.io** for real-time delivery tracking
- **Expo Push Notifications** for alerts

### Current Data Flow
```
Mobile App (Expo)
    ↓ HTTP REST (fetch)
Express.js API Server
    ↓ Raw SQL (better-sqlite3)
SQLite File (database.sqlite)
    ↓
Local Filesystem (uploads/)
```

### Where SQLite is Used
- `server/config/database.js` — Schema initialization (45+ tables)
- All route files use `getDb()` → synchronous SQL via `better-sqlite3`
- WAL mode for concurrent reads, but single-writer limitation
- Database file stored alongside server code

### Architectural Weaknesses for Production

| Issue | Risk | Impact |
|-------|------|--------|
| **SQLite** | Single-writer, no concurrent writes | Cannot handle multiple simultaneous orders |
| **Hardcoded LAN IP** | App references `192.168.29.160` | App unusable outside local network |
| **Local file uploads** | Images in `/uploads/` directory | Lost on container restart, not scalable |
| **No connection pooling** | One db connection | Memory/performance issues |
| **CORS: `origin: '*'`** | Open to any domain | Security vulnerability |
| **Weak JWT secret** | `namanTestProject` | Easily guessable |
| **No rate limiting** | Open to abuse | DDoS/brute-force attacks |
| **No request validation** | SQL injection surface | Data corruption |
| **No logging** | `console.log` only | No audit trail |
| **No health monitoring** | Basic `/api/health` | No alerting |
| **Cron in process** | Recurring orders & geofence in main thread | Blocks event loop |
| **No caching** | Every request hits DB | Unnecessary load |
| **No HTTPS** | Plain HTTP | Data interceptable |

---

## 2. PRODUCTION ARCHITECTURE

### Architecture Diagram

```
                    ┌───────────────────────────────┐
                    │     Mobile App (Expo EAS)      │
                    │   React Native + Expo ~54      │
                    │   API URL from env config      │
                    └──────────┬────────────────────┘
                               │ HTTPS
                               ▼
                    ┌──────────────────────┐
                    │   Load Balancer /     │
                    │   Reverse Proxy       │
                    │   (Nginx / Caddy)     │
                    │   SSL Termination     │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
     │ API Server  │  │ API Server  │  │ API Server  │
     │ (Node.js)   │  │ (Node.js)   │  │ (Node.js)   │
     │ Express     │  │ Express     │  │ Express     │
     │ Instance 1  │  │ Instance 2  │  │ Instance N  │
     └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
            │                │                 │
            └────────────────┼─────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼               ▼
     ┌─────────────┐  ┌──────────┐  ┌─────────────┐
     │ PostgreSQL  │  │  Redis   │  │  AWS S3 /    │
     │  Primary    │  │ Cache +  │  │  CloudFlare  │
     │ + Replica   │  │ Sessions │  │  R2 (Files)  │
     └─────────────┘  │ + PubSub │  └─────────────┘
                       └──────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Mobile App** | React Native + Expo EAS | Customer & staff interface |
| **API Server** | Node.js + Express.js | Business logic, REST API |
| **Database** | PostgreSQL 16 | Primary data store |
| **Cache** | Redis 7 | Session cache, rate limiting, Socket.io adapter |
| **File Storage** | AWS S3 / Cloudflare R2 | Product images, delivery proofs |
| **Reverse Proxy** | Nginx / Caddy | SSL, load balancing |
| **Background Jobs** | Bull (Redis-backed) | Recurring orders, notifications |
| **Monitoring** | Pino logger + Sentry | Error tracking, structured logs |

### Communication Flow
1. App → HTTPS → Nginx → API Server (round-robin)
2. API Server → PostgreSQL via connection pool (pg-pool)
3. API Server → Redis for caching, rate limits, Socket.io pub/sub
4. API Server → S3 for file uploads/downloads
5. Socket.io → Redis adapter for multi-instance messaging
6. Background jobs → Bull queues on Redis

---

## 3. DATABASE MIGRATION

### Migration Strategy: SQLite → PostgreSQL

### Key Type Changes

| SQLite | PostgreSQL | Notes |
|--------|-----------|-------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL` or `BIGSERIAL` | Auto-incrementing |
| `TEXT` | `VARCHAR(n)` or `TEXT` | Length-bounded where appropriate |
| `REAL` | `DECIMAL(10,2)` or `DOUBLE PRECISION` | Precision for money |
| `INTEGER` (boolean) | `BOOLEAN` | `0/1` → `true/false` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | `TIMESTAMPTZ DEFAULT NOW()` | Timezone-aware |
| `CHECK(role IN (...))` | `CREATE TYPE ... AS ENUM(...)` | PostgreSQL enums |
| JSON as TEXT | `JSONB` | Native JSON querying |

### PostgreSQL Schema

See `server/config/schema.sql` for the complete PostgreSQL schema.

### Migration Plan

1. **Export** current SQLite data → JSON/CSV
2. **Create** PostgreSQL database with new schema
3. **Transform** data types (INTEGER booleans → BOOLEAN, etc.)
4. **Import** transformed data
5. **Verify** row counts and data integrity
6. **Update** all server route files to use `pg` library
7. **Test** all 70+ API endpoints

### Indexing Strategy

| Table | Index | Reason |
|-------|-------|--------|
| `users` | `phone`, `email`, `role` | Login lookups, role filtering |
| `sales` | `location_id + created_at`, `customer_id`, `status` | Reports, dashboards |
| `sale_items` | `sale_id`, `product_id` | Order detail lookups |
| `attendance` | `user_id + date`, `location_id + date` | Clock-in checks, reports |
| `materials` | `category_id`, `sku` | Inventory queries |
| `material_stock` | `material_id + location_id` | Stock lookups |
| `deliveries` | `delivery_partner_id + status`, `sale_id` | Partner views |
| `notifications` | `user_id + is_read` | Unread counts |
| `production_tasks` | `sale_id`, `assigned_to + status` | Task queues |

---

## 4. PRODUCTION BACKEND

### Changes from Current Code
- **Database**: `better-sqlite3` → `pg` (node-postgres) with connection pooling
- **Validation**: `express-validator` (already installed, now used consistently)
- **Logging**: `console.log` → `pino` structured logger
- **Rate Limiting**: `express-rate-limit` + Redis store
- **File Uploads**: Multer → S3 (via `@aws-sdk/client-s3`)
- **Background Jobs**: In-process `setInterval` → Bull queues
- **Caching**: Redis for frequently-accessed data
- **Error Handling**: Enhanced with request IDs

See the generated production files for full implementation.

---

## 5. MOBILE APP CHANGES

### Environment Configuration

Replace hardcoded LAN IP with Expo environment config:

```javascript
// app/src/services/api.js
import Constants from 'expo-constants';

function getBaseUrl() {
  // EAS builds use env vars baked at build time
  const apiUrl = Constants.expoConfig?.extra?.apiUrl
    || process.env.EXPO_PUBLIC_API_URL
    || 'http://localhost:3001/api';
  return apiUrl;
}
```

### app.config.js (replaces app.json for dynamic config)

```javascript
export default {
  expo: {
    name: "BloomCart POS",
    slug: "bloomcart-pos",
    // ... existing config
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://localhost:3001/api",
      eas: { projectId: "your-eas-project-id" },
    },
  },
};
```

### Offline Caching

For production, add offline-first capability:

```javascript
// Cache critical data in AsyncStorage
import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@bloomcart_cache_';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function cachedRequest(key, fetchFn) {
  try {
    // Try cache first
    const cached = await AsyncStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_TTL) return data;
    }
  } catch {}

  // Fetch from API
  const data = await fetchFn();

  // Cache the result
  try {
    await AsyncStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({
      data, timestamp: Date.now()
    }));
  } catch {}

  return data;
}
```

---

## 6. PERFORMANCE & SCALABILITY

| Optimization | Implementation | Impact |
|-------------|---------------|--------|
| **Connection Pooling** | `pg.Pool({ max: 20 })` | Reuse DB connections, ~10x throughput |
| **Database Indexes** | Composite indexes on hot queries | Query time: O(n) → O(log n) |
| **Redis Caching** | Cache settings, tax rates, products | Reduce DB load by 60-80% |
| **Rate Limiting** | 100 req/min general, 5/min for login | Prevent abuse |
| **Pagination** | Already implemented, enforce limits | Prevent memory overflow |
| **Compression** | `compression` middleware | 60-70% response size reduction |
| **Background Jobs** | Bull queues for notifications, reports | Unblock request handlers |
| **Query Optimization** | SELECT only needed columns | Reduce data transfer |
| **CDN for Images** | S3 + CloudFront/R2 | Sub-50ms image loads globally |
| **HTTP/2** | Via reverse proxy | Multiplexed connections |

---

## 7. SECURITY HARDENING

| Measure | Implementation |
|---------|---------------|
| **JWT Secret** | 64-char random string from `crypto.randomBytes(32)` |
| **HTTPS** | SSL via Let's Encrypt (auto-renew with Caddy) |
| **CORS** | Restrict to app bundle ID + admin domain |
| **Helmet** | Already in place — enhanced for production |
| **Rate Limiting** | `express-rate-limit` with Redis store |
| **Input Validation** | `express-validator` on all endpoints |
| **SQL Injection** | Parameterized queries (already done) |
| **Password Policy** | bcrypt with 12 rounds (already done) |
| **Secrets** | `.env` file, never committed; use platform secrets in prod |
| **Dependency Audit** | `npm audit` in CI pipeline |
| **Request IDs** | UUID per request for audit trail |

### Production .env Template
```env
NODE_ENV=production
PORT=3001

# Database
DATABASE_URL=postgresql://user:password@host:5432/bloomcart?sslmode=require

# Authentication
JWT_SECRET=<64-char-random-hex>
JWT_EXPIRES_IN=7d

# Redis
REDIS_URL=redis://:password@host:6379/0

# File Storage (S3/R2)
S3_BUCKET=bloomcart-uploads
S3_REGION=ap-south-1
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_ENDPOINT=  # Leave empty for AWS, set for R2/MinIO

# CORS
ALLOWED_ORIGINS=https://admin.bloomcart.com

# Sentry (Error Tracking)
SENTRY_DSN=https://xxx@sentry.io/xxx

# Expo Push
EXPO_ACCESS_TOKEN=<optional-for-higher-rate-limits>
```

---

## 8. DOCKERIZATION

See generated files:
- `server/Dockerfile` — Multi-stage Node.js build
- `docker-compose.yml` — Full stack (API + PostgreSQL + Redis)
- `server/.dockerignore` — Exclude unnecessary files

### Quick Start
```bash
# Development
docker compose up -d

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 9. DEPLOYMENT PIPELINE

### Option A: Railway (Recommended for simplicity)

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Create project
railway init

# 4. Add PostgreSQL
railway add -p postgresql

# 5. Add Redis
railway add -p redis

# 6. Set environment variables
railway variables set NODE_ENV=production
railway variables set JWT_SECRET=$(openssl rand -hex 32)
railway variables set JWT_EXPIRES_IN=7d
# ... set all other env vars

# 7. Deploy
railway up
```

### Option B: DigitalOcean App Platform

1. Connect GitHub repo
2. Add PostgreSQL managed database ($7/mo)
3. Add Redis managed cache ($10/mo)
4. Configure environment variables
5. Deploy from `main` branch
6. Enable auto-deploy on push

### Option C: AWS (Full Control)

```
ECS Fargate (API containers)
    + RDS PostgreSQL (database)
    + ElastiCache Redis (cache)
    + S3 + CloudFront (files)
    + ALB (load balancer)
    + ACM (SSL certificates)
    + CloudWatch (monitoring)
```

### Database Deployment
- Use managed PostgreSQL (Railway, Render, RDS, DigitalOcean)
- Enable SSL connections
- Set up daily automated backups
- Configure connection pooling (PgBouncer if >50 connections)

---

## 10. EXPO EAS DEPLOYMENT

### Initial Setup

```bash
# Install EAS CLI
npm install -g eas-cli

# Login to Expo
eas login

# Initialize EAS in the app directory
cd app
eas init

# Configure builds
eas build:configure
```

### eas.json Configuration

```json
{
  "cli": { "version": ">= 15.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": {
        "EXPO_PUBLIC_API_URL": "http://192.168.29.160:3001/api"
      }
    },
    "preview": {
      "distribution": "internal",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://staging-api.bloomcart.com/api"
      }
    },
    "production": {
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.bloomcart.com/api"
      }
    }
  },
  "submit": {
    "production": {
      "android": {
        "serviceAccountKeyPath": "./google-services.json",
        "track": "production"
      },
      "ios": {
        "appleId": "your-apple-id@email.com",
        "ascAppId": "your-app-store-connect-id"
      }
    }
  }
}
```

### Build Commands

```bash
# Development build (for testing)
eas build --platform android --profile development
eas build --platform ios --profile development

# Preview build (for internal testing)
eas build --platform android --profile preview
eas build --platform ios --profile preview

# Production build
eas build --platform android --profile production
eas build --platform ios --profile production
```

### OTA Updates (No App Store Review)

```bash
# Push an update to all production users
eas update --branch production --message "Bug fix: order display"
```

### App Store Submission

```bash
# Submit to Google Play / Apple App Store
eas submit --platform android --profile production
eas submit --platform ios --profile production
```

---

## 11. CI/CD PIPELINE

See `.github/workflows/deploy.yml` for the full GitHub Actions pipeline.

### Pipeline Stages

```
Push to main
    ↓
┌─────────────┐
│   Lint &     │  eslint, prettier
│   Validate   │  npm audit
└──────┬──────┘
       ↓
┌─────────────┐
│   Test       │  API tests, unit tests
│              │  PostgreSQL service container
└──────┬──────┘
       ↓
┌─────────────┐
│   Build      │  Docker image
│   & Push     │  → Container registry
└──────┬──────┘
       ↓
┌─────────────┐
│   Deploy     │  Railway / Render / AWS
│              │  Health check verification
└─────────────┘
```

---

## 12. FINAL PROJECT STRUCTURE

```
bloomcart/
├── .github/
│   └── workflows/
│       └── deploy.yml              # CI/CD pipeline
│
├── app/                            # Mobile app (Expo)
│   ├── app.config.js               # Dynamic Expo config
│   ├── eas.json                    # EAS build profiles
│   ├── package.json
│   ├── babel.config.js
│   ├── src/
│   │   ├── components/
│   │   ├── constants/
│   │   ├── context/
│   │   ├── hooks/
│   │   ├── navigation/
│   │   ├── screens/
│   │   └── services/
│   │       ├── api.js              # API client (env-based URL)
│   │       └── cache.js            # Offline cache layer
│   └── assets/
│
├── server/                         # Backend API
│   ├── Dockerfile                  # Multi-stage Docker build
│   ├── .dockerignore
│   ├── package.json
│   ├── server.js                   # Entry point
│   ├── config/
│   │   ├── database.js             # PostgreSQL pool + migrations
│   │   ├── redis.js                # Redis client
│   │   ├── s3.js                   # S3/R2 file storage
│   │   └── schema.sql              # PostgreSQL schema
│   ├── middleware/
│   │   ├── auth.js                 # JWT authentication
│   │   ├── errorHandler.js         # Global error handler
│   │   ├── rateLimiter.js          # Rate limiting
│   │   └── validate.js             # Request validation
│   ├── routes/                     # API routes (21 files)
│   ├── utils/
│   │   ├── time.js                 # Timezone utilities
│   │   └── logger.js               # Pino structured logger
│   ├── jobs/
│   │   ├── queue.js                # Bull queue setup
│   │   ├── recurringOrders.js      # Cron: recurring orders
│   │   └── geofenceTimeout.js      # Cron: auto clock-out
│   └── scripts/
│       └── migrate-sqlite-to-pg.js # Data migration script
│
├── docker-compose.yml              # Development stack
├── docker-compose.prod.yml         # Production overrides
├── .env.example                    # Environment template
├── PRODUCTION-GUIDE.md             # This document
└── README.md
```

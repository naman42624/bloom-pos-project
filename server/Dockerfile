# ============================================================
# BloomCart API — Multi-stage Production Dockerfile
# ============================================================

# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Production image
FROM node:20-alpine AS runner
WORKDIR /app

# Security: create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 bloomcart

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Remove dev files
RUN rm -rf .env .env.* *.test.js test-* scripts/migrate-* \
    database.sqlite* uploads/ .git .gitignore

# Create uploads directory (for local dev fallback)
RUN mkdir -p uploads && chown bloomcart:nodejs uploads

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Switch to non-root user
USER bloomcart

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start server
CMD ["node", "server.js"]

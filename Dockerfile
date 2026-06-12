# ═════════════════════════════════════════════════════════════════════════════
# NEVARA Blue Carbon Ledger — Production Docker Configuration
# ═════════════════════════════════════════════════════════════════════════════
#
# BUILD: docker build -t nevara:latest --build-arg NODE_ENV=production .
# RUN:   docker run -p 5000:5000 --env-file .env.production nevara:latest
#
# Optimizations:
#   - Multi-stage build (builder → production)
#   - Non-root user (security hardening)
#   - Layer caching: install deps before copying source
#   - .dockerignore controls what's copied (keep image small)
#   - Only production node_modules in final image
# ═════════════════════════════════════════════════════════════════════════════

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /app

# Install system build dependencies for native modules (better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++ git

# Copy dependency manifests first (layer cache optimization)
COPY package.json package-lock.json* ./

# Install ALL deps (including devDeps needed for build)
RUN npm ci --include=dev

# Copy source
COPY . .

# Build frontend + bundle server
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-alpine AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
# Disable telemetry
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Install runtime-only OS deps
RUN apk add --no-cache \
    # Required for Puppeteer/Chromium (PDF rendering)
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    # Required for PostGIS client (psql for health checks)
    postgresql-client \
    # curl for health check script
    curl

# Tell Puppeteer to skip downloading Chromium (we installed it above)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy production node_modules from builder (skip devDeps)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/shared ./shared

# Create data directories for file storage
RUN mkdir -p /data/nevara/rasters /data/nevara/tiles \
             /data/nevara/thumbnails /data/nevara/reports \
             /data/nevara/field_evidence /data/nevara/colormaps

# Create non-root user for security
RUN addgroup -S nevara && adduser -S nevara -G nevara

# Set ownership
RUN chown -R nevara:nevara /app /data

USER nevara

# Expose port
EXPOSE 5000

# Health check using our liveness probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:5000/api/health > /dev/null

# Start production server
CMD ["node", "dist/index.js"]

# =========================
# Base image
# =========================
FROM node:22-alpine AS base
WORKDIR /app

# Set a sane default; you can override in docker-compose
ENV NODE_ENV=production

# Avoid npm telemetry noise
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false

# =========================
# Install dependencies (prod only)
# =========================
FROM base AS deps

# Install dependencies needed to build native modules (if any)
RUN apk add --no-cache python3 make g++ 

COPY package.json package-lock.json ./

# Install ONLY production deps for the final image
RUN npm ci --omit=dev

# =========================
# Build stage (needs devDependencies)
# =========================
FROM base AS builder

# Dev env for best TypeScript / build behavior
ENV NODE_ENV=development

# Build tooling
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

# Copy source and TS config
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript -> dist/
RUN npm run build

# =========================
# Runtime image
# =========================
FROM node:22-alpine AS runner
WORKDIR /app

# Security: don't run as root
USER node

ENV NODE_ENV=production

# Copy package.json for npm scripts
COPY package.json ./

# Copy production node_modules and built JS
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Expose API port
EXPOSE 5000

# Healthcheck (simple HTTP hit to /health)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:5000/health', r => { if (r.statusCode !== 200) process.exit(1); }).on('error', () => process.exit(1));"

# Start both API server and worker (via package.json "start")
CMD ["npm", "start"]

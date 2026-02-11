# Multi-stage build for SARdine
# Production-ready container for cloud deployment

# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build the application
RUN npm run build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:18-slim

WORKDIR /app

# Install curl for health checks
RUN apt-get update && \
    apt-get install -y curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm install --production --legacy-peer-deps

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy server files
COPY server ./server

# Create data directory with proper permissions
RUN mkdir -p /data/nisar && \
    chown -R node:node /app /data/nisar

# Switch to non-root user for security
USER node

# Expose default port
EXPOSE 8050

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8050/ || exit 1

# Default command
CMD ["node", "server/launch.cjs"]

# Environment variables (can be overridden at runtime)
ENV PORT=8050 \
    DATA_DIR=/data/nisar \
    NODE_ENV=production

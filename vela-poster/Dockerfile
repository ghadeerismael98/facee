FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including dev for TypeScript build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# --- Production image ---
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built JS from builder
COPY --from=builder /app/dist ./dist

# Copy UI files
COPY ui/ ./ui/

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /home/appuser/.face-poster \
    && chown -R appuser:appgroup /home/appuser/.face-poster
USER appuser

EXPOSE 3000

CMD ["node", "dist/server.js"]

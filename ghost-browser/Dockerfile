FROM node:20-slim

# Install Chromium dependencies + Tor
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-noto-color-emoji fonts-liberation fonts-noto-cjk \
    tor curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r ghost && useradd -r -g ghost -G audio,video ghost \
    && mkdir -p /app /data && chown -R ghost:ghost /app /data

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright Chromium — install as root, then fix permissions for ghost user
RUN npx playwright install --with-deps chromium \
    && chmod -R 755 /root/.cache/ms-playwright || true
# Also install for the ghost user path
RUN mkdir -p /home/ghost/.cache && cp -r /root/.cache/ms-playwright /home/ghost/.cache/ \
    && chown -R ghost:ghost /home/ghost/.cache

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Switch to non-root user
USER ghost

# Persist profile data
VOLUME /data

ENV PORT=1306
ENV DATA_DIR=/data
EXPOSE 1306

CMD ["node", "dist/index.js"]

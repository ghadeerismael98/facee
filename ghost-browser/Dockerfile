FROM node:20-slim

# Install dependencies + Tor + real Google Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-noto-color-emoji fonts-liberation fonts-noto-cjk \
    tor curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome (real Chrome, not Chromium)
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r ghost && useradd -r -g ghost -G audio,video ghost \
    && mkdir -p /app /data && chown -R ghost:ghost /app /data

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright browsers (Chrome channel + Chromium as fallback)
RUN npx playwright install --with-deps chrome chromium 2>/dev/null || \
    npx playwright install --with-deps chromium
RUN mkdir -p /home/ghost/.cache \
    && (cp -r /root/.cache/ms-playwright /home/ghost/.cache/ 2>/dev/null || true) \
    && chown -R ghost:ghost /home/ghost

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Switch to non-root user
USER ghost

VOLUME /data

ENV PORT=1306
ENV DATA_DIR=/data
EXPOSE 1306

CMD ["node", "dist/index.js"]

FROM node:20-slim

# Install Chromium dependencies + Tor + VNC/noVNC stack
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-noto-color-emoji fonts-liberation fonts-noto-cjk \
    tor curl \
    xvfb x11vnc novnc websockify supervisor \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r ghost && useradd -r -g ghost -G audio,video ghost \
    && mkdir -p /app /data /var/log/supervisor /tmp/.X11-unix \
    && chown -R ghost:ghost /app /data /var/log/supervisor \
    && chmod 1777 /tmp/.X11-unix

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright browsers
RUN npx playwright install --with-deps chromium || true
# Copy to ghost user home
RUN mkdir -p /home/ghost/.cache \
    && (cp -r /root/.cache/ms-playwright /home/ghost/.cache/ 2>/dev/null || true) \
    && chown -R ghost:ghost /home/ghost

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy supervisor config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Persist profile data
VOLUME /data

ENV PORT=1306
ENV DATA_DIR=/data
ENV DISPLAY=:99
ENV VNC_PASSWORD=ghostvnc
# Use system Chromium for headed mode compatibility
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 1306 6080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]

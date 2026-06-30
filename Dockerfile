# ─────────────────────────────────────────────────────────────
# ravena-ai Dockerfile
# Node.js bot — no Chromium, no Puppeteer
# ─────────────────────────────────────────────────────────────
# syntax=docker/dockerfile:1
FROM node:20-slim

# Prevent apt from cleaning downloaded packages to keep them in cache
RUN rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

# System dependencies: ffmpeg for media, imagemagick for image processing
# Using apt-get for Debian-based image with build cache mounts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    curl \
    jq \
    python3 \
    make \
    g++ \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc

# Set working directory
WORKDIR /app

# Install Node dependencies first (layer cache optimization)
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy application source
COPY . .

# Persistent data directories (mapped as volumes in docker-compose)
RUN mkdir -p /app/data /app/public /app/downloads

EXPOSE 5000

CMD ["node", "--dns-result-order=ipv4first", "index.js"]

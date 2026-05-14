# ─────────────────────────────────────────────────────────────
# ravena-ai Dockerfile
# Node.js bot — no Chromium, no Puppeteer
# ─────────────────────────────────────────────────────────────
FROM node:20-slim

# System dependencies: ffmpeg for media, imagemagick for image processing
# Using apt-get for Debian-based image
RUN apt-get update && apt-get install -y \
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
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install Node dependencies first (layer cache optimization)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Persistent data directories (mapped as volumes in docker-compose)
RUN mkdir -p /app/data /app/public /app/downloads

EXPOSE 5000

CMD ["node", "--dns-result-order=ipv4first", "index.js"]

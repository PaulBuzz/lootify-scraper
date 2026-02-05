FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    wget ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libvpx7 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    libxslt1.1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY server.js ./
COPY scraper-hybrid.js ./

EXPOSE 3000

CMD ["node", "server.js"]

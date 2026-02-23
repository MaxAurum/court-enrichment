FROM ghcr.io/puppeteer/puppeteer:22.0.0

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 10000
CMD ["node", "server.js"]

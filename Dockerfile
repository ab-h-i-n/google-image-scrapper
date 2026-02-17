FROM ghcr.io/puppeteer/puppeteer:24.3.0

USER root
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD [ "node", "server.js" ]

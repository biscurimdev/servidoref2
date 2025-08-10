FROM node:20-bookworm

RUN apt-get update && apt-get install -y chromium \
  fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdbus-1-3 libnss3 libxss1 lsb-release wget xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm","start"]


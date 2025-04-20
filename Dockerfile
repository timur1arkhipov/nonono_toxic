FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV TELEGRAM_BOT_TOKEN="your_telegram_bot_token"

CMD ["node", "bot.js"] 
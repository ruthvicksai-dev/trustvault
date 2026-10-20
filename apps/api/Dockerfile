FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci

COPY apps/api ./apps/api

WORKDIR /app/apps/api

RUN npm run build

EXPOSE 4000

CMD ["npm", "run", "start"]
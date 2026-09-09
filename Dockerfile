# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci && npm ci --prefix server

COPY . .
RUN npx vite build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV PGLITE_DATA_DIR=/data/pglite

COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev && npm ci --prefix server --omit=dev

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY .env.example ./.env.example

RUN mkdir -p /data/pglite
EXPOSE 3001
WORKDIR /app/server
CMD ["npx", "tsx", "src/index.ts"]

FROM node:25-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY server ./server

RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts

EXPOSE 4322

CMD ["node", "server/comment-api.mjs"]

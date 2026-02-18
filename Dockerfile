FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

RUN pnpm prune --prod

ENV TZ=America/New_York
CMD ["node", "dist/index.js"]

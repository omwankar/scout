FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV HOST=0.0.0.0
ENV CORS_ORIGIN=*
ENV NEXT_PUBLIC_API_URL=""
ENV WEB_DIST=/app/apps/web/out

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Playwright browsers ship in the base image; skip download during install
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Render may inject NODE_ENV=production at build time — still need typescript/etc.
RUN pnpm install --frozen-lockfile=false --prod=false

COPY . .

# Same-origin API calls from the static UI
ENV NEXT_PUBLIC_API_URL=

RUN pnpm --filter @scout/shared build \
  && pnpm --filter @scout/web build \
  && pnpm --filter @scout/api build

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 10000
CMD ["node", "dist/index.js"]

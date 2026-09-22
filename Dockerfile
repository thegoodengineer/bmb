# Referee image for `npx @insforge/cli compute deploy . --name bmb-referee`.
# Builds the pnpm workspace and runs the referee main loop. The victim link is created at
# boot from env (see apps/referee/bin/boot.sh); no secrets are baked into the image.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/referee/package.json apps/referee/
RUN pnpm install --frozen-lockfile --filter @bmb/shared --filter @bmb/referee
COPY packages/shared packages/shared
COPY apps/referee apps/referee
COPY victim/functions victim/functions
RUN pnpm --filter @bmb/shared build && pnpm --filter @bmb/referee build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/victim/.insforge
ENV NODE_ENV=production
ENV VICTIM_DIR=../../victim
ENV MISSES_DIR=/app/data
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "/app/apps/referee/bin/boot.sh"]

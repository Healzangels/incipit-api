# Base with bun installed
FROM oven/bun:alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

# Builder with all deps
FROM base AS build
# copy everything to the container
COPY . .

RUN bun install --frozen-lockfile --ignore-scripts && bun run build-ts

# Production deps only
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# prod
FROM base AS prod

# Build identity, surfaced by GET /version so a deploy can be verified in one
# curl instead of inferred from "docker compose pull" output. Declared in THIS
# stage only: an ARG in an earlier stage would invalidate that stage's layer
# cache on every commit and force a full rebuild for a value only the final
# image needs. Defaults keep a plain `docker build` working with no args.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

# copy built app to /app
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json .

USER bun

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD curl -f http://localhost:3000/health || exit 1
CMD ["bun", "run", "serve"]
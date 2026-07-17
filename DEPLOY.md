# Deploying incipit-api (self-host)

A self-contained stack: the API plus MongoDB plus Redis, all internal. Mongo
backs the inherited audnexus routes (author search, ASIN data lookup, chapters);
Redis caches provider search results (easing Hardcover's 60 req/min limit) and
audnexus responses. Nothing depends on an external service.

## Prerequisites

- Docker with Compose v2 (`docker compose`).
- The repo checked out (has the search route, providers, and this compose).

## Unraid (Docker Compose Manager) — recommended for Unraid

The app is a three-container stack, so run it as one compose project rather than
a single-container template.

1. **Make the image pullable.** Either make the GHCR package public once
   (GitHub → your profile → Packages → incipit-api → Package settings → Change
   visibility → Public), or on Unraid run `docker login ghcr.io` with a token.
2. Install **Docker Compose Manager** from Community Applications.
3. Add a new stack (e.g. `incipit-api`) and paste this compose — it uses the
   pre-built image, so no source is needed on Unraid:

   ```yaml
   services:
     incipit-api:
       image: ghcr.io/healzangels/incipit-api:latest
       restart: unless-stopped
       depends_on:
         mongo: { condition: service_healthy }
         redis: { condition: service_healthy }
       environment:
         MONGODB_URI: mongodb://mongo:27017
         REDIS_URL: redis://redis:6379
         HOST: 0.0.0.0
         PORT: "3000"
         LOG_LEVEL: info
         DEFAULT_REGION: us
         HARDCOVER_TOKEN: ${HARDCOVER_TOKEN:-}
         OL_CONTACT: ${OL_CONTACT:-}
       ports:
         - "3000:3000"
     mongo:
       image: mongo:7
       restart: unless-stopped
       volumes: [ mongo-data:/data/db ]
       healthcheck:
         test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
         interval: 10s
         timeout: 5s
         retries: 5
         start_period: 20s
     redis:
       image: redis:7-alpine
       restart: unless-stopped
       volumes: [ redis-data:/data ]
       healthcheck:
         test: ["CMD", "redis-cli", "ping"]
         interval: 10s
         timeout: 5s
         retries: 5
   volumes:
     mongo-data:
     redis-data:
   ```

4. In the stack's **.env** (Compose Manager has an env editor), set:
   ```
   HARDCOVER_TOKEN=<your own token from hardcover.app/settings>
   OL_CONTACT=you@example.com
   ```
5. **Compose Up.** The API is now on `http://<unraid-ip>:3000`.
6. In Plex → the Incipit agent → set **API base URL** to `http://<unraid-ip>:3000`.

Update later: `docker compose pull` + up (Compose Manager has Update/Up buttons).

### Attaching to an existing Docker network

To put the stack on a network you already run (e.g. a reverse-proxy bridge),
declare it external and attach each service. Give the datastores distinct names
so they don't collide with other stacks' `mongo`/`redis` aliases on the shared
network, and point the URIs at those names:

```yaml
networks:
  your-network:
    external: true
services:
  incipit-api:
    # ... image, ports, etc.
    environment:
      MONGODB_URI: mongodb://incipit-mongo:27017
      REDIS_URL: redis://incipit-redis:6379
    networks: [ your-network ]
  incipit-mongo:   # renamed from `mongo`
    # ... image: mongo:7, healthcheck, volume
    networks: [ your-network ]
  incipit-redis:   # renamed from `redis`
    # ... image: redis:7-alpine, healthcheck, volume
    networks: [ your-network ]
```

Mongo and Redis have no auth by default, so on a shared network anything on it
can reach them — fine for a trusted internal bridge. To keep them private, put
only `incipit-api` on the shared network and the datastores on a separate
`internal` network that just `incipit-api` also joins.

## Run — build from source (works today, no registry setup)

```bash
git clone -b feat/multi-provider-search https://github.com/Healzangels/incipit-api.git
cd incipit-api
cp .env.example .env
# edit .env — at minimum set OL_CONTACT; add your own HARDCOVER_TOKEN to enable Hardcover
docker compose up -d --build
```

The API comes up on port 3000 (change with `API_PORT` in `.env`). Mongo is
internal to the compose network — no published port.

## Run — pre-built image (no build step)

Once an image is published to the registry (via the Docker workflow — run it from
the Actions tab, or it publishes automatically on a push to `main`), self-host
without cloning or building:

1. Make the GHCR package public once (GitHub → your profile → Packages →
   incipit-api → Package settings → Change visibility → Public), or authenticate
   Docker to GHCR to pull a private image.
2. In `docker-compose.yml`, comment out `build: .` and set
   `image: ghcr.io/healzangels/incipit-api:latest`.
3. `docker compose pull && docker compose up -d`.

Every provider credential is the operator's own or keyless: Hardcover uses your
token (or is skipped if blank), Audible's catalog and OpenLibrary need none.

## Verify (smoke tests)

```bash
HOST=http://localhost:3000     # or http://<server-ip>:3000

# 1. health
curl -fsS $HOST/health

# 2. inherited audnexus lookup by ASIN (exercises Mongo) — Project Hail Mary
curl -fsS "$HOST/books/B08G9PRS1K?region=us" | head -c 300

# 3. the new multi-provider search (Audible + Hardcover + OpenLibrary)
curl -fsS "$HOST/books?title=A+Spell+for+Chameleon&author=Piers+Anthony" | head -c 400

# 3b. with a per-user Hardcover token via header (instead of the env default)
curl -fsS -H "x-hardcover-token: <token>" \
  "$HOST/books?title=Project+Hail+Mary&author=Andy+Weir&duration=58200000" | head -c 400
```

Search 3 should return ranked, provider-tagged candidates (a Xanth book with no
Audible edition still matches via Hardcover/OpenLibrary).

## Point the Plex agent at it

In Plex → the Incipit agent settings:

- **API base URL** → `http://<server-ip>:3000`
- **Hardcover token** → your own token (or leave blank and rely on the API's env
  default)

## Notes

- No `.env` is ever baked into the image (it's in `.dockerignore` and
  `.gitignore`); tokens are supplied at runtime.
- Audible chapter support (`ADP_TOKEN`/`PRIVATE_KEY`) is off by default and not
  needed for matching or metadata.
- Update: `git pull`, then `docker compose up -d --build`.

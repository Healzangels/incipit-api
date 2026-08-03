# Unraid templates

Deploy the stack from the Unraid webgui instead of `docker compose`. Three
containers, same shape as `docker-compose.yml`: **incipit-mongo**, **incipit-redis**
and **incipit-api**.

## Why a custom network

The compose stack gets container-name DNS for free (`mongodb://mongo:27017`).
Unraid's default `bridge` does **not** resolve container names, so the three must
share a *user-defined* network. Create it once, before deploying anything:

```
docker network create incipit
```

Skip this and the API starts, fails to reach Mongo, and exits — with a message
about `MONGODB_URI` that looks like a config typo rather than a missing network.

The alternative — publishing Mongo and Redis on host ports and pointing the API at
the Unraid IP — works, but puts an unauthenticated database on your LAN. Don't.

## Install

Copy the three XML files to your Unraid server:

```
/boot/config/plugins/dockerMan/templates-user/
```

They then appear under **Docker → Add Container → Template**, in the user
templates section.

## Order matters

Unraid templates have no `depends_on`. Start them in this order:

1. `incipit-mongo`
2. `incipit-redis`
3. `incipit-api`

The API exits at boot if Mongo is unreachable, so starting it first just means
restarting it afterwards.

## What each one needs

| container | published port | storage | required config |
|---|---|---|---|
| incipit-mongo | none | `/mnt/user/appdata/incipit-mongo` | — |
| incipit-redis | none | `/mnt/user/appdata/incipit-redis` | — |
| incipit-api | `3737 → 3000` | none | `MONGODB_URI` |

Mongo and Redis publish nothing on purpose — only the API talks to them.

`HARDCOVER_TOKEN` is your own; blank simply skips that provider. Nothing is
bundled.

## Image tags

`:nightly` tracks the default branch. `:release` is stable.

Avoid `:latest` — it builds from `release` only, so pulling it after a nightly
change is a silent no-op: the container comes back healthy running the *old*
build. Verify what you're actually running with:

```
docker inspect incipit-api -f '{{.Config.Image}}'
```

## Rate limiting during a first scan

A from-scratch Plex library scan can rate-limit itself. Set
`RATE_LIMIT_ALLOWLIST` to the source IP **the API actually sees** — which is
usually the docker bridge gateway, not the Plex host. Read it off the container
log's `remoteAddress` field rather than guessing.

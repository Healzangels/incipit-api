# Unraid templates

Deploy the stack from the Unraid webgui instead of `docker compose`. Three
containers, same shape as `docker-compose.yml`: **incipit-mongo**, **incipit-redis**
and **incipit-api**.

## Set the network first — this is the one that bites

The compose stack gets container-name DNS for free (`mongodb://mongo:27017`).
Unraid's default `bridge` does **not** resolve container names.

So before starting anything, change **Network** on all three containers to a
*user-defined* network — either one you already run, or a new one
(`docker network create <name>`). Any user-defined bridge works; they just have to
be on the **same** one. The templates ship with `bridge` because that is Unraid's
stock value, not because it works.

Leave it on `bridge` and the API starts, cannot reach Mongo, and exits — reporting
`MONGODB_URI`, which reads like a config typo rather than a networking problem.
That is the whole failure: a correct URI on the wrong network.

If your network is **macvlan/ipvlan** (containers hold their own LAN IPs) rather
than a bridge, container-name DNS is unreliable — put static IPs in `MONGODB_URI`
and `REDIS_URL` instead of names, and note that Mongo and Redis then answer to your
whole LAN.

The remaining alternative — publishing Mongo and Redis on host ports and pointing
the API at the server IP — works, but puts an unauthenticated database on your LAN.
Don't.

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

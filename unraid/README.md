# Unraid template

Deploy from the Unraid webgui instead of `docker compose`. **One container**:
`incipit-api`, with a built-in SQLite database and an in-process cache. There is
no mongo, no redis, no inter-container networking, and no start order — the
whole class of "correct URI on the wrong network" failures this README used to
document is gone with the containers that caused it.

## The data path — this is the one that bites now

The template maps `/data` to a host path where the SQLite database lives. Two
rules, both learned the hard way:

1. **Use a cache-pool path** (`/mnt/cache/appdata/incipit-api`), never the
   `/mnt/user/...` FUSE view. SQLite file locking over FUSE is a corruption
   vector — Plex's own appdata follows the same rule on this platform.
2. **`chown 1000:1000` the directory once before first start.** The container
   runs as uid 1000 (not Unraid's `nobody`), and this is its first-ever disk
   write: it must create `incipit.db`, `-wal` and `-shm` there. Skipping this
   fails the boot loudly with "cannot open database".

```
mkdir -p /mnt/cache/appdata/incipit-api && chown 1000:1000 /mnt/cache/appdata/incipit-api
```

## Install

Copy `my-incipit-api.xml` to your Unraid server:

```
/boot/config/plugins/dockerMan/templates-user/
```

It appears under **Docker → Add Container → Template**, in the user templates
section. The stock `bridge` network is fine — nothing needs container-name DNS
any more.

## What it needs

| container | published port | storage | required config |
|---|---|---|---|
| incipit-api | `3737 → 3000` | `/data` → `/mnt/cache/appdata/incipit-api` | the path mapping above |

`HARDCOVER_TOKEN` is your own; blank simply skips that provider. Nothing is
bundled. `GOODREADS_SERIES_URL` optionally points at your own rreading-glasses
instance; blank uses the shared public mirror, which rate-limits.

**Legacy backends:** `DB_BACKEND=mongo` + `MONGODB_URI` and an external
`REDIS_URL` still work for existing deployments, but new installs should not
use them — they resurrect the multi-container networking rules this template
retired. If you do, the mongo container must share a *user-defined* docker
network with the API (`bridge` does not resolve container names).

## Backup

One consistent snapshot, safe while serving:

```
docker exec incipit-api bun run backup
```

Writes `incipit-backup-YYYYMMDD.db` next to the live file. A plain `cp` of a
live database can catch it mid-checkpoint — use the command.

## Icons

The API icon lives in `assets/` (SVG source + the raster PNG Unraid's `<Icon>`
field needs). Until the PNG is committed the container falls back to Unraid's
default icon — nothing breaks, it just looks unset.

## Image tags

`:nightly` tracks the default branch. `:release` is stable.

Avoid `:latest` — it builds from `release` only, so pulling it after a nightly
change is a silent no-op: the container comes back healthy running the *old*
build. Verify what you're actually running with:

```
docker inspect incipit-api -f '{{.Config.Image}}'
```

## Rate limiting during a first scan

Direct requests from private/loopback space — including the Plex agent's
docker-bridge hop — are exempt from the rate limit automatically, so a
from-scratch scan no longer 429s itself. `RATE_LIMIT_ALLOWLIST` remains for
proxied clients that need exemption; the exemption never applies to requests
arriving through a proxy.

<p align="center">
  <a href="" rel="noopener">
 <img width=200px height=200px src="../assets/logos/logo.png?raw=true" alt="Project logo"></a>
</p>

<h3 align="center">audnexus</h3>

<div align="center">

[![Status](https://img.shields.io/badge/status-active-success.svg)]()
[![GitHub Issues](https://img.shields.io/github/issues/djdembeck/audnexus.svg)](https://github.com/djdembeck/audnexus/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/djdembeck/audnexus.svg)](https://github.com/djdembeck/audnexus/pulls)
[![License](https://img.shields.io/badge/license-GNUGPL-blue.svg)](/LICENSE)
[![CodeFactor Grade](https://img.shields.io/codefactor/grade/github/djdembeck/audnexus)](https://www.codefactor.io/repository/github/djdembeck/audnexus)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=laxamentumtech_audnexus&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=laxamentumtech_audnexus)

</div>

---

<p align="center"> An audiobook data aggregation API, combining multiple sources of data into one, consistent source.
    <br> 
</p>

## 📝 Table of Contents

- [About](#about)
- [Getting Started](#getting_started)
- [Running the tests](#tests)
- [Error Handling](#error_handling)
- [Usage](#usage)
- [Deployment](#deployment)
- [Built Using](#built_using)
- [TODO](../TODO.md)
- [Contributing](../CONTRIBUTING.md)
- [Authors](#authors)
- [Acknowledgments](#acknowledgement)

## 🧐 About <a name = "about"></a>

Incipit-api reconciles audiobook metadata from several sources into one answer, so a
book that never had an Audible release still resolves. It is a fork of
[audnexus](https://github.com/djdembeck/audnexus), and it is meant to be **run by you**
— it is the backend for your own [Incipit.bundle](https://github.com/Healzangels/Incipit.bundle)
Plex agent, not a shared public service.

Providers fanned out per lookup: **Audible, Hardcover, Chaptarr, Apple, OverDrive and
OpenLibrary**. The API reconciles them rather than picking one — the match, the series,
the genres and the cover art can each come from whichever source actually has them, and
a candidate's stated runtime is weighed against the file's real duration so a wrong
edition can be demoted.

Because it is self-hosted, provider credentials live in this deployment's own
environment. Nothing is forwarded per request from a client.

## 🏁 Getting Started <a name = "getting_started"></a>

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See [deployment](#deployment) for notes on how to deploy the project on a live system.

### Prerequisites

- There are 3 ways to deploy this project:
  - [Coolify](https://coolify.io) - Self-hosted PaaS platform with automatic deployments from Git
  - [Docker Swarm](https://docs.docker.com/engine/swarm/swarm-tutorial/) - Docker Compose stack with Traefik reverse proxy
  - Directly, via `bun run`
    - Mongo 4 or greater
    - [Bun](https://bun.sh/) 1.3.9 or greater
    - Redis
  - Registered Audible device keys, `ADP_TOKEN` and `PRIVATE_KEY`, for chapters. You will need Python and `audible` for this. [More on that here](https://audible.readthedocs.io/en/latest/auth/register.html)

### Installing locally

- Install Mongo and Redis on your system
- Install [Bun](https://bun.sh/)
- `bun install` from project directory to get dependencies

**Required environment variables:**

- `MONGODB_URI`: MongoDB connection URL (e.g., `mongodb://localhost:27017/audnexus`)

**Storage — pick one:**

- `MONGODB_URI` — the default backend.
- `DB_BACKEND=sqlite` plus `SQLITE_PATH` — single-file storage, no Mongo needed.
  Defaults to `./data/incipit.db` when unset.

`REDIS_URL` is not strictly required, but **several features silently do nothing
without it.** Alternate-cover computation in particular records its answer in redis
and will not run at all if there is nowhere to record it — including the empty
answer, so the work is not repeated on every request.

**Providers:**

| variable | why you want it |
|---|---|
| `GOODREADS_SERIES_URL` | The series source. Defaults to the SHARED public `https://api.bookinfo.pro`, which is one box serving thousands of users — expect rate limiting. Point it at your own [rreading-glasses](https://github.com/blampe/rreading-glasses) instance instead; the request pacing relaxes automatically when it is not the shared host. |
| `HARDCOVER_TOKEN` | Hardcover genres, series and author portraits. Lives here, in the deployment's own environment — it is never accepted per request from a client. |
| `CHAPTARR_ENABLED` | Chaptarr as a supplementary source. |
| `OL_CONTACT` | Contact string sent to OpenLibrary, which their API asks of automated clients. |
| `ADP_TOKEN`, `PRIVATE_KEY` | Audible device keys, needed only for the chapters endpoint. |

**Write protection** — the delete routes refuse to run unless one of these is set, so
an unconfigured deployment cannot be told to delete things:

- `DELETE_AUTH_TOKEN` and/or `DELETE_ALLOWED_IPS`
- `METRICS_AUTH_TOKEN` / `METRICS_ALLOWED_IPS` gate `/metrics` the same way
- `TRUSTED_PROXIES`, or `TRUST_CLOUDFLARE=true`, so client IPs are read from the
  right header when behind a proxy

**Tuning (rarely needed)** — request pacing and match thresholds are env-tunable
without a rebuild: `HARDCOVER_MIN_GAP_MS`, `HARDCOVER_COOLDOWN_MS`,
`GOODREADS_MIN_GAP_MS`, `GOODREADS_BACKOFF_MS`, `GOODREADS_TIME_BUDGET_MS`,
`IMAGES_SIMILAR_MAX_DISTANCE`, `DURATION_TIE_EPSILON_SECONDS`.

Then start the server:

```bash
bun run watch-debug
```

Test an API call with

```
http://localhost:3000/books/${ASIN}
```

## 🔧 Running the tests <a name = "tests"></a>

Tests for this project use Bun's built-in test runner. Tests can be done locally in a dev environment:

- `bun run test`

After the tests have run, you may also browse the test coverage. This is generated in `coverage/` directory under the project directory.

## ⚠️ Error Handling <a name = "error_handling"></a>

The API returns structured error responses with error codes, HTTP status codes, and detailed messages.

### Error Response Format

All errors follow this structure. The `details` field is optional and may be omitted or set to `null`:

```json
{
	"error": {
		"code": "ERROR_CODE",
		"message": "Human-readable error message",
		"details": null
	}
}
```

### Error Codes

| Code                    | HTTP Status | Description                                                                               |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `CONTENT_TYPE_MISMATCH` | 400         | Content type doesn't match the requested endpoint (e.g., podcast ASIN on /books endpoint) |
| `VALIDATION_ERROR`      | 422         | Schema validation failed                                                                  |
| `REGION_UNAVAILABLE`    | 404         | Content not available in the requested region                                             |
| `NOT_FOUND`             | 404         | Generic not found error                                                                   |
| `BAD_REQUEST`           | 400         | Bad request                                                                               |
| `RATE_LIMIT_EXCEEDED`   | 429         | Too many requests — client has exceeded allowed request rate                              |

### Example Error Responses

**Content Type Mismatch (Podcast on Book endpoint):**

```json
{
	"error": {
		"code": "CONTENT_TYPE_MISMATCH",
		"message": "Item is a podcast, not a book. ASIN: B017V4U2VQ",
		"details": {
			"asin": "B017V4U2VQ",
			"requestedType": "book",
			"actualType": "PodcastParent"
		}
	}
}
```

**Region Unavailable:**

```json
{
	"error": {
		"code": "REGION_UNAVAILABLE",
		"message": "Item not available in region 'us' for ASIN: B12345",
		"details": {
			"asin": "B12345"
		}
	}
}
```

**Validation Error:**

```json
{
	"error": {
		"code": "VALIDATION_ERROR",
		"message": "Schema validation failed for request",
		"details": {
			"field": "asin",
			"issue": "Invalid ASIN format"
		}
	}
}
```

**Not Found:**

```json
{
	"error": {
		"code": "NOT_FOUND",
		"message": "Book with ASIN B12345 not found",
		"details": {
			"asin": "B12345",
			"endpoint": "/books"
		}
	}
}
```

**Bad Request:**

```json
{
	"error": {
		"code": "BAD_REQUEST",
		"message": "Invalid request parameters",
		"details": {
			"parameter": "region",
			"issue": "Unsupported region 'xx'"
		}
	}
}
```

**Rate Limit Exceeded:**

```json
{
	"error": {
		"code": "RATE_LIMIT_EXCEEDED",
		"message": "Too many requests — client has exceeded allowed request rate",
		"details": {
			"retryAfterSeconds": 60
		}
	}
}
```

## 🎈 Usage <a name="usage"></a>

The OpenAPI spec in this repo is the reference — upstream's https://audnex.us/ documents
audnexus, not this fork, and does not cover what Incipit adds (`/images/similar`,
`imageAlternates`, the series and genre reconciliation).

Pre-rendered HTML documentation is included in `docs/index.html`.

HTML can be re-generated from the spec, using:

```bash
bun run build-docs
```

## 🚀 Deployment <a name = "deployment"></a>

### Coolify Deployment

Audnexus can be deployed to Coolify, a self-hosted open-source alternative to Vercel.

**Setup Steps:**

1. **Connect repository to Coolify:**
   - In Coolify, create a new application
   - Select "Git" and connect your GitHub repository
   - Select the branch (e.g., `main` or `develop`)

2. **Configure environment variables:**
   - Set up the following environment variables in Coolify:

   **Core Configuration:**
   - `MONGODB_URI`: MongoDB connection URL (e.g., `mongodb://mongo:27017/audnexus`) [required]
   - `REDIS_URL`: Redis connection URL (e.g., `redis://redis:6379`) [optional]
   - `HOST`: Server host address (default: `0.0.0.0`)
   - `PORT`: Server port (default: `3000`)
   - `LOG_LEVEL`: Log level - `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`)
   - `TRUSTED_PROXIES`: Comma-separated list of trusted proxy IPs/CIDR ranges (optional)
   - `DEFAULT_REGION`: Default region for batch processing (default: `us`)

   **Audible API Configuration:**
   - `ADP_TOKEN`: Audible ADP_TOKEN value (optional, for chapters endpoint)
   - `PRIVATE_KEY`: Audible PRIVATE_KEY value (optional, for chapters endpoint)

   **Rate Limiting:**
   - `MAX_REQUESTS`: Max requests per minute per source (default: 100)

   **Update Scheduling:**
   - `UPDATE_INTERVAL`: Update interval in days (default: 30)
   - `UPDATE_THRESHOLD`: Minimum days before checking updates again (default: 7)

   **Performance Tuning:**
   - `MAX_CONCURRENT_REQUESTS`: HTTP connection pool size for concurrent API calls (default: 50)
   - `SCHEDULER_CONCURRENCY`: Max concurrent scheduler operations (default: 5)
   - `SCHEDULER_MAX_PER_REGION`: Hard cap for max per-region concurrency in batch processing (default: 5)
   - `HTTP_MAX_SOCKETS`: Maximum HTTP sockets (hard limit: 50, default: 50) - values above 50 will be clamped to 50
   - `HTTP_TIMEOUT_MS`: HTTP request timeout in milliseconds (default: 30000)

   **Feature Flags (Boolean - supports `true`, `True`, `TRUE`, `1`):**
   - `USE_PARALLEL_SCHEDULER`: Enable parallel UpdateScheduler (default: `false`) - HIGH RISK, requires testing
   - `USE_CONNECTION_POOLING`: Enable HTTP connection pooling for API calls (default: `true`)
   - `USE_COMPACT_JSON`: Use compact JSON format in Redis (default: `true`)
   - `USE_SORTED_KEYS`: Sort object keys in responses (adds O(n log n) overhead, default: `false`)
   - `CIRCUIT_BREAKER_ENABLED`: Enable circuit breaker pattern for external API calls (default: `true`)
   - `METRICS_ENABLED`: Enable performance metrics collection and /metrics endpoint (default: `true`)

   **SQLite backup (DB_BACKEND=sqlite only):**
   - `SQLITE_BACKUP_INTERVAL_HOURS`: How often the container snapshots its own database (default: `24`; `0` disables). Uses `VACUUM INTO`, which is safe while serving. Under SQLite the entire datastore is one file on one volume, so this runs unattended rather than relying on anyone remembering.
   - `SQLITE_BACKUP_KEEP`: How many dated snapshots to retain (default: `7`). Only files matching `incipit-backup-YYYYMMDD.db` are ever removed — the live database and any hand-named copy are left alone.
   - `BACKUP_MIN_FRACTION`: Size floor for a snapshot, as a fraction of the largest of (live db, existing backup) (default: `0.5`). Refuses to overwrite a good backup with a suspiciously small one. Lower it for a one-off after a genuine bulk delete.

   **Provider Toggles:**
   - `CHAPTARR_ENABLED`: Query the Chaptarr metadata service (default: `true`; set `false` to disable). Keyless. Supplements Audible with narrator, duration, chapters and cross-provider ids, and resolves ASINs Audible has delisted — an Audible "husk" (a product id it still acknowledges but serves no title for) falls through to Chaptarr instead of losing the operator's pin. It is another project's free infrastructure, so it sits behind its own circuit breaker; this flag is the kill switch.
   - `STORYTEL_ENABLED`: Query Storytel (default: `false`). Keyless, real narrator + runtime, but its English catalogue is thin for indie SF/LitRPG — useful mainly for mainstream or European libraries.
   - `APPLE_ENABLED`: Query Apple Books (default: `true`). Keyless; the main source of square cover art.
   - `OVERDRIVE_ENABLED`: Query OverDrive/Libby (default: `true`). Keyless library catalogue that often carries what Audible lacks — Blackstone, Recorded Books, older and indie titles — with narrator, runtime and cover, so its candidates are real audio editions rather than print fallbacks. It has no ASIN, so a duration-confirmed Audible edition still outranks it.
   - `OVERDRIVE_LIBRARY`: Which OverDrive library's holdings to search (optional; defaults to a large public library). Results are scoped to that library's catalogue.
   - `LIBRIVOX_ENABLED`: Query LibriVox for public-domain recordings (default: `false`).

   **Metrics Endpoint Security:**
   - `METRICS_AUTH_TOKEN`: Authentication token for /metrics endpoint (optional)
   - `METRICS_ALLOWED_IPS`: Comma-separated list of allowed IPs/CIDR ranges for /metrics (supports CIDR notation, optional)

3. **Configure build and deployment:**
   - Build command: Coolify will automatically use the Dockerfile
   - Port: 3000
   - Health check: Coolify can use the `/health` endpoint

4. **Enable GitHub webhook (optional):**
   - In Coolify, get your webhook URL from the application's "Webhook" section
   - Add `COOLIFY_WEBHOOK` to your GitHub repository secrets with this URL
   - In Coolify, create an API token from "Keys & Tokens" > "API Tokens" (enable "Deploy" permission)
   - Add `COOLIFY_TOKEN` to your GitHub repository secrets with the API token
   - The workflow `.github/workflows/deploy-coolify.yml` will trigger deployments automatically on pushes to `main` or `develop`

**Note:** The `.github/workflows/docker-publish.yml` workflow builds and pushes Docker images to GitHub Container Registry (ghcr.io) but does not deploy them. The Coolify workflow builds, pushes, and deploys the Docker image using the Coolify API.

5. **Optional: Configure persistent volumes for MongoDB/Redis:**
   - For production, consider using external MongoDB and Redis services
   - Or configure Coolify to use managed databases

**Important:** The audnexus application requires MongoDB and Redis services to run. You must either:

- Use Coolify's managed database services or external databases
- Deploy the full stack (including MongoDB and Redis containers) using the Docker Compose method in the Docker Swarm section below

Do not proceed with Coolify deployment until you have the `MONGODB_URI` and `REDIS_URL` values ready.

**Note:** For production deployments, consider using Coolify's managed database services for MongoDB and Redis, or deploy the full stack using the Docker Compose method below.

### Docker Swarm Deployment

Once you have Docker Swarm setup, grab the `docker-compose.yml` from this repo, and use it to start the stack. Using something like Portainer for a Swarm GUI will make this much easier.

The stack defaults to 15 replicas for the node-server container. Customize this as needed.

**Core Environment Variables:**

- `MONGODB_URI`: MongoDB connection URL, such as `mongodb://mongo/audnexus`
- `REDIS_URL`: Redis connection URL, such as `redis://redis:6379`
- `HOST`: Server host address (default: `0.0.0.0`)
- `PORT`: Server port (default: `3000`)
- `LOG_LEVEL`: Log level - `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`)
- `TRUSTED_PROXIES`: Comma-separated list of trusted proxy IPs/CIDR ranges (optional)
- `DEFAULT_REGION`: Default region for batch processing (default: `us`)

**Audible API Configuration:**

- `ADP_TOKEN`: Audible ADP_TOKEN value (optional, for chapters endpoint)
- `PRIVATE_KEY`: Audible PRIVATE_KEY value (optional, for chapters endpoint)

**Rate Limiting:**

- `MAX_REQUESTS`: Maximum number of requests per 1-minute period from a single source (default: 100)

**Update Scheduling:**

- `UPDATE_INTERVAL`: Frequency (in days) to run scheduled update tasks (default: 30). Update task is also run at startup.
- `UPDATE_THRESHOLD`: Minimum number of days after an item is updated, to allow it to check for updates again (either scheduled or parameter).

**Performance Tuning:**

- `MAX_CONCURRENT_REQUESTS`: HTTP connection pool size for concurrent API calls (default: 50)
- `SCHEDULER_CONCURRENCY`: Max concurrent scheduler operations (default: 5)
- `SCHEDULER_MAX_PER_REGION`: Hard cap for max per-region concurrency in batch processing (default: 5)
- `HTTP_MAX_SOCKETS`: Maximum HTTP sockets (hard limit: 50, default: 50) - values above 50 will be clamped to 50
- `HTTP_TIMEOUT_MS`: HTTP request timeout in milliseconds (default: 30000)

**Feature Flags (Boolean - supports `true`, `True`, `TRUE`, `1`):**

- `USE_PARALLEL_SCHEDULER`: Enable parallel UpdateScheduler (default: `false`) - HIGH RISK, requires testing
- `USE_CONNECTION_POOLING`: Enable HTTP connection pooling for API calls (default: `true`)
- `USE_COMPACT_JSON`: Use compact JSON format in Redis (default: `true`)
- `USE_SORTED_KEYS`: Sort object keys in responses (adds O(n log n) overhead, default: `false`)
- `CIRCUIT_BREAKER_ENABLED`: Enable circuit breaker pattern for external API calls (default: `true`)
- `METRICS_ENABLED`: Enable performance metrics collection and /metrics endpoint (default: `true`)

**Metrics Endpoint Security:**

- `METRICS_AUTH_TOKEN`: Authentication token for /metrics endpoint (optional)
- `METRICS_ALLOWED_IPS`: Comma-separated list of allowed IPs/CIDR ranges for /metrics (supports CIDR notation, optional)

**Traefik Configuration:**

- `TRAEFIK_DOMAIN`: FQDN for the API server
- `TRAEFIK_EMAIL`: Email to register SSL cert with

Once the stack is up, test an API call with

```
https://${TRAEFIK_DOMAIN}/books/${ASIN}
```

### Set up DB indexes to keep item lookups fast and to support searches.

1. Connect to the DB either from inside the mongodb container terminal or a MongoDB Compass/MongoSH session.

2. Switch to the correct DB:

   ```
   use audnexus
   ```

3. Create the recommended indexes:
   ```
   db.authors.createIndex( { asin: 1, region: 1 } )
   ```
   ```
   db.books.createIndex( { asin: 1, region: 1 } )
   ```
   ```
   db.chapters.createIndex( { asin: 1, region: 1 } )
   ```
   ```
   db.authors.createIndex( { name: "text" } )
   ```

## ⛏️ Built Using <a name = "built_using"></a>

- [Fastify](https://www.fastify.io/) - Server Framework
- [MongoDB](https://www.mongodb.com/) - Database
- [Bun](https://bun.sh/) - Server Runtime
- [Papr](https://github.com/plexinc/papr) - Database connection
- [Redis](https://redis.io/) - Cached responses

## ✍️ Authors <a name = "authors"></a>

- [@djdembeck](https://github.com/djdembeck) — idea and initial work on
  [audnexus](https://github.com/djdembeck/audnexus), which this project is a fork of.
  The API shape, provider scaffolding and Fastify/Mongo groundwork are upstream's;
  GPL-3.0 is inherited with them.

Series data is served by [rreading-glasses](https://github.com/blampe/rreading-glasses)
(GPL-3.0) — self-host it and point `GOODREADS_SERIES_URL` at your instance.

## 🎉 Acknowledgements <a name = "acknowledgement"></a>

- Huge thanks to [mkb79](https://github.com/mkb79) and their [audible](https://github.com/mkb79/Audible) project for a great starting point.
- [macr0dev](https://github.com/macr0dev) for introducing us to scraping.
- [seanap](https://github.com/seanap) for passionately standardizing audiobook organization.
- [Bookcamp](https://www.bookcamp.app/) for giving us a reason to have awesome audiobook data.

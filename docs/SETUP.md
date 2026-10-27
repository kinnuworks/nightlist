# Live setup: Zetaris and Nightshift

Sample mode needs none of this. These steps switch Nightlist to the live data layer and model runtime.

## 1. EHR database (PostgreSQL)

The clinic EHR runs as a PostgreSQL container seeded from `data/sources/ehr/*.csv`:

```bash
docker compose -f infra/docker-compose.yml up -d
```

It listens on port 5433 (database `ehr`, user and password `nightlist`).

## 2. Zetaris (local, in Docker)

Zetaris runs on your machine in Docker. Plan for 30 to 45 minutes the first time, 8 GB of memory and 4 CPUs given to Docker, and 15 GB of free disk. These steps follow the hackathon's Participant Setup Guide and [Zetaris's getting-started repository](https://github.com/zetaris/getting-started).

1. Register at [cloud.enterprise.zetaris.com/register](https://cloud.enterprise.zetaris.com/register). On the **Run locally** page (`/dashboard/download`), download `zetaris-platform.zip` and copy the registry sign-in command.
2. On an Apple Silicon Mac, turn on **Use Rosetta** in Docker's settings (the Zetaris images are built for Intel and AMD).
3. Unpack, sign in and check the machine:

```bash
unzip zetaris-platform.zip && cd zetaris-platform
docker login zetarishackathon.azurecr.io
./preflight.sh
```

4. In `zetaris-platform/.env`, set `ZETARIS_ADMIN_EMAIL`, `ZETARIS_ADMIN_PASSWORD` and `ZETARIS_ADMIN_ORG` before the first start, and keep the laptop settings from the guide (`ZSPARK_MASTER_URL=local[2]`, `ZSPARK_DRIVER_MEM=2g`). That file belongs to Zetaris; never copy it into this project.
5. Zetaris cannot read files on your laptop. Start it with the override in this repo, which mounts `data/` read-only into the query engine at `/home/zetaris/customer-data/shared/nightlist` (where `ZETARIS_FILE_ROOT` points):

```bash
export NIGHTLIST_DATA=/absolute/path/to/nightlist/data
docker compose -f docker-compose.yml -f /absolute/path/to/nightlist/infra/zetaris-mount.override.yml pull
docker compose -f docker-compose.yml -f /absolute/path/to/nightlist/infra/zetaris-mount.override.yml up -d
docker compose ps --all
./verify.sh
```

Wait until `init` and `bootstrap` show `Exited (0)` and `verify.sh` reports 9 of 9.

6. Open [http://localhost:3000](http://localhost:3000), sign in, run `SELECT 1 AS one;` in the SQL Editor, then create an API key for your user and copy it.
7. In this project's `.env`: `ZETARIS_REST_URL=http://localhost:8888/api/v1.0`, `ZETARIS_ORG_ID=1`, `ZETARIS_API_KEY=<the key>`. Inside Zetaris's containers the EHR database is at `host.docker.internal:5433`, which is already the default for `EHR_JDBC_URL`.
8. Generate and apply the SQL:

```bash
npm run zetaris:sql
```

```bash
npm run zetaris:setup
```

The runner sends `sql/01_sources.sql` through `sql/06_proof.sql` to `POST /sql-editor/sqls/run` one statement at a time (bearer key, `X-Org-ID`, a fresh `X-Request-ID` per request) and records every statement and result in `docs/zetaris-run.md`. Step 02 holds the exploratory queries per source, 03 compiles the USL, 04 activates it, 05 registers the data-quality rules, and 06 shows the USL is active and the rules execute.

9. Set `SAMPLE_MODE=false` in `.env`. The screener now sends its SQL to Zetaris.

Every night run rewrites the compiled trial feed under `data/`. Because the folder is mounted, Zetaris sees the new files without copying.

## 3. Meterless Nightshift and NVIDIA Nemotron

1. From [meterless.ai](https://meterless.ai/), scroll to the install cards and download the Nightshift edition for your machine (Mac M5+ for M5 and later, Mac M1+ for M1 to M4). Verify your email at the access gate, install, launch, and leave it running.
2. Create an NVIDIA API key at [build.nvidia.com/models](https://build.nvidia.com/models). In Nightshift, open **Setup > Providers**, choose NVIDIA and paste the key there. The key never goes in this project.
3. In **NIGHT > LANES**, add a fast lane with a Nemotron Lightning model and a deep lane with a Nemotron Super model (use the exact names in Nightshift's model picker).
4. Open **Console** (top right) and copy the Runtime URL and API key into `.env`:

```bash
METERLESS_BASE_URL=http://127.0.0.1:8088/v1
METERLESS_RUNTIME_TOKEN=<token from the Console>
```

The older names `NIGHTSHIFT_URL`, `NIGHTSHIFT_TOKEN` and `NIGHTSHIFT_TOKEN_FILE` still work.

5. Check the connection (export the token in your shell first; `.env` is not exported automatically):

```bash
curl -s -H "Authorization: Bearer $METERLESS_RUNTIME_TOKEN" -H "meterless-app: nightlist" -H "meterless-scope: user" http://127.0.0.1:8088/v1/models
```

6. The Compiler uses `METERLESS_MODEL` (default `meterless/deep`) and the Checker uses `NIGHTSHIFT_CHECK_MODEL` (default `meterless/fast`). Point them at the Nemotron-backed routes listed by `/v1/models`. `meterless/auto` can route to a non-NVIDIA model, so pin a Nemotron route if you want the trace to prove Nemotron did the work.
7. Run a night, then write the proof file:

```bash
npm run night
```

```bash
npm run nightshift:report -w server
```

Criteria the rules could not compile go to the model, every compiled criterion is back-translated, and the trace records the model Nightshift reports for each request. `docs/nightshift-run.md` summarises them.

Model compilations and checks are cached in `data/compiled/criteria-cache.json` with the serving model recorded, so sample mode replays them on machines without Nightshift.

## 4. Running Nightlist in Docker

```bash
docker build -t nightlist .
docker run --rm -p 8787:8787 nightlist
```

The image starts in sample mode, runs the two demo nights on first start and serves the UI and API on port 8787. For live mode pass your settings with `--env-file .env`, and use `host.docker.internal` instead of `localhost` or `127.0.0.1` for Zetaris (`http://host.docker.internal:8888/api/v1.0`) and Nightshift (`http://host.docker.internal:8088/v1`), because inside a container `localhost` is the container itself.

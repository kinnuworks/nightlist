# Live setup: Zetaris and Nightshift

Sample mode needs none of this. These steps switch Nightlist to the live data layer and model runtime.

## 1. EHR database (PostgreSQL)

The clinic EHR runs as a PostgreSQL container seeded from `data/sources/ehr/*.csv`:

```bash
docker compose -f infra/docker-compose.yml up -d
```

It listens on port 5433 (database `ehr`, user and password `nightlist`).

## 2. Zetaris

Use the participant instance, or install locally following the [Zetaris getting-started guide](https://zetaris.github.io/getting-started/). Then:

1. In `.env`, set `ZETARIS_REST_URL`, `ZETARIS_API_KEY` and `ZETARIS_ORG_ID`.
2. Set `ZETARIS_FILE_ROOT` to the path where the Zetaris server can read this repository's `data/` folder (for a local Docker install, mount the folder and use `file:///...`; for a cloud instance, upload `data/sources` and `data/runtime/compiled` to object storage and use the `s3a://` path).
3. Set `EHR_JDBC_URL` to an address the Zetaris server can reach the PostgreSQL container on.
4. Generate and apply the SQL:

```bash
npm run zetaris:sql
```

```bash
npm run zetaris:setup
```

The runner executes `sql/01_sources.sql` through `sql/06_proof.sql` one statement at a time and records every statement and result in `docs/zetaris-run.md`. Step 02 holds the exploratory queries per source, 03 compiles the USL, 04 activates it, 05 registers the data-quality rules, and 06 shows the USL is active and the rules execute.

5. Set `SAMPLE_MODE=false` in `.env`. The screener now sends its SQL to Zetaris.

The compiled trial feed (`data/runtime/compiled/*.csv`) is rewritten by every night run. In live mode, make sure the path Zetaris reads is the same folder, or copy the files after `npm run night`.

## 3. Meterless Nightshift and NVIDIA Nemotron

1. Install Nightshift from [meterless.ai](https://meterless.ai/) and start the runtime.
2. Create an NVIDIA API key at [build.nvidia.com](https://build.nvidia.com/) and add it in Nightshift's Providers tab. The key never goes in this project.
3. In `.env`, set `NIGHTSHIFT_URL` (default `http://127.0.0.1:8088/v1`) and either `NIGHTSHIFT_TOKEN` or `NIGHTSHIFT_TOKEN_FILE` (the runtime writes the token to `<stateDir>/proxy-token`).
4. Check the connection:

```bash
curl -s -H "Authorization: Bearer $NIGHTSHIFT_TOKEN" -H "meterless-app: nightlist" http://127.0.0.1:8088/v1/models
```

5. Route `meterless/deep` to a large Nemotron model and `meterless/fast` to a small one in Nightshift, or set `NIGHTSHIFT_COMPILE_MODEL` and `NIGHTSHIFT_CHECK_MODEL` to the routes you prefer.
6. Run a night. Criteria the rules could not compile now go to the model, every compiled criterion is back-translated, and the trace shows which model served each request:

```bash
npm run night
```

Model compilations and checks are cached in `data/compiled/criteria-cache.json` with the serving model recorded, so sample mode replays them on machines without Nightshift.

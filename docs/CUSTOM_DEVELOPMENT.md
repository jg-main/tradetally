# Custom development and image promotion

`main` is an unmodified mirror of `GeneBO98/tradetally:main`. Do not make
custom commits there. `custom` is the long-lived branch for normal local
changes and the source of the canonical HomeLab application image.

## Synchronize upstream

From the `main` worktree:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main

git switch custom
git merge main
# resolve and test if needed
git push origin custom
```

The normal workflow uses a merge from `main` into `custom`; do not routinely
rebase the long-lived `custom` branch.

## Normal development and canonical rebuild

Work only from `~/Projects/tradetally-custom`. Commit your changes, then build
and deploy the deterministic production image through HomeLab:

```bash
git status
git add ...
git commit -m "Describe the change"

cd ~/Projects/HomeLab
make tradetally-rebuild
```

This always creates a PostgreSQL backup, builds `tradetally-custom:latest` from
this worktree with the production Dockerfile, then recreates only the canonical
`tradetally` application container. It uses HomeLab's existing ignored runtime
environment and the existing PostgreSQL, upload, and backup volumes. It does
not bind-mount source code, recreate `tradetally-db`, or alter persistent data.

## Optional isolated sandbox

For risky work—especially migrations, calculations, imports, broker sync,
authentication, or large refactors—use the separate local sandbox:

```bash
cp .env.dev.example .env.dev
docker compose --env-file .env.dev -f docker-compose.custom-dev.yaml up -d --build
```

It uses separate PostgreSQL, upload, and backup volumes. For source hot reload
inside that isolated setup, keep its PostgreSQL service running and use the
upstream development commands in separate terminals:

```bash
docker compose --env-file .env.dev -f docker-compose.custom-dev.yaml up -d postgres
pnpm install --frozen-lockfile
DB_HOST=127.0.0.1 DB_PORT=5433 pnpm --dir backend dev
VITE_API_URL=http://localhost:3000/api pnpm --dir frontend dev
```

The production Dockerfile serves a compiled frontend and does not provide a
runtime hot-reload process. The canonical application is deliberately rebuilt,
not source-mounted; the upstream `nodemon`/Vite commands are sandbox-only.

## Images and promotion

Pushing `custom` runs the optional `Publish custom GHCR image` workflow. After
its tests pass, it publishes `ghcr.io/jg-main/tradetally:custom-latest` and
immutable `ghcr.io/jg-main/tradetally:custom-<short-sha>` tags. The workflow
only builds and publishes; normal HomeLab deployment uses the local image and
does not depend on GHCR.

Configure the GHCR package as **public** once in its GitHub package settings so
HomeLab can pull it without registry credentials. Use an immutable GHCR tag as
an optional recovery/reference path, or test `custom-latest` in
`https://tradetally-dev.homelab`; neither is mandatory for the normal rebuild
workflow.

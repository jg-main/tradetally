# Custom development and image promotion

`main` is an unmodified mirror of `GeneBO98/tradetally:main`. Do not make
custom commits there. `custom` is the long-lived branch for local changes and
the source of the HomeLab development image.

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

## Local development

Work only from `~/Projects/tradetally-custom`. Create a development-only
environment and start the isolated containerized stack:

```bash
cp .env.dev.example .env.dev
docker compose --env-file .env.dev -f docker-compose.custom-dev.yaml up -d --build
```

It uses the `tradetally-local-dev` Compose project, containers named
`tradetally-local-dev-*`, localhost-only ports 8081/5433 (and optional Adminer
on 8082), and its own PostgreSQL, upload, and backup volumes. It never refers
to HomeLab production volumes.

For source hot reload, keep the isolated PostgreSQL service running and use the
upstream development commands in separate terminals:

```bash
docker compose --env-file .env.dev -f docker-compose.custom-dev.yaml up -d postgres
pnpm install --frozen-lockfile
DB_HOST=127.0.0.1 DB_PORT=5433 pnpm --dir backend dev
VITE_API_URL=http://localhost:3000/api pnpm --dir frontend dev
```

The production Dockerfile serves a compiled frontend and does not provide a
runtime hot-reload process, so the local stack is for image-parity testing and
the upstream `nodemon`/Vite commands are the hot-reload path.

## Images and promotion

Pushing `custom` runs the `Publish custom GHCR image` workflow. After its tests
pass, it publishes `ghcr.io/jg-main/tradetally:custom-latest` and immutable
`ghcr.io/jg-main/tradetally:custom-<short-sha>` tags. The workflow only builds
and publishes; it never deploys production.

Configure the GHCR package as **public** once in its GitHub package settings so
HomeLab can pull it without registry credentials. Test `custom-latest` in
`https://tradetally-dev.homelab`; promote only the corresponding immutable SHA
with HomeLab's `make tradetally-prod-deploy image=...` command. That command
backs up the production database before recreating only the application
container.

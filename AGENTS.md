# TradeTally Agent Instructions

## Repository purpose

This repository is Javier's fork of TradeTally.

- `main` is kept as a clean mirror of `GeneBO98/tradetally:main`.
- `custom` is the long-lived branch for Javier's customizations and is the source used for the canonical HomeLab application image.
- Normal custom development must happen on `custom`, never on `main`.
- The normal local worktree is `~/Projects/tradetally-custom`.

Read `docs/CUSTOM_DEVELOPMENT.md` before changing deployment or development workflow behavior.

## Current major feature

The authoritative functional specification for setup-specific quality grading is:

`docs/QUALITY_PROFILES_REQUIREMENT.md`

For work related to Quality Profiles, Setup Quality, Entry Quality, Management Quality, Canonical BO, or playbook-linked grading:

1. Read the relevant section of `docs/QUALITY_PROFILES_REQUIREMENT.md` before editing code.
2. Treat that document as the product requirement. Do not silently replace its rules with generic trading assumptions.
3. Implement one user-approved milestone at a time. Do not continue into later milestones merely because they are described in the requirement.
4. Keep the implementation generic enough for future profiles, but do not build a strategy DSL, plugin system, or speculative abstraction not required by the current milestone.
5. If the current code cannot support a required evidence source, return/represent the documented missing-data state rather than fabricating evidence.

## Quality-system invariants

These rules are architectural requirements unless the user explicitly changes the specification:

- Setup Quality, Entry Quality, and Management Quality are independent dimensions.
- Do not create a combined overall quality score.
- Outcome/PnL/R must not influence quality scoring.
- Quality score and Compliance are independent.
- Criterion states are `PASS`, `FAIL`, `NOT_APPLICABLE`, and `UNKNOWN`.
- A known required failure makes dimension Compliance `FAIL` without forcing the numerical quality score to zero.
- A required `UNKNOWN` makes Compliance `INCOMPLETE` when no known required failure exists.
- `NOT_APPLICABLE` does not reduce coverage; `UNKNOWN` does.
- Profile configuration is versioned and historical evaluations are immutable snapshots.
- Editing a profile creates a new version; it must not silently re-grade historical trades.
- User-configurable trading thresholds belong in profile configuration, not hard-coded evaluator logic.
- Mathematical formulas and evaluator types may be implemented in code.
- Do not require manual entry for machine-observable metrics such as ATR, ADR, SMA, RVOL, range contraction, volume contraction, pivot distance, MFE, or MAE.
- Semantic user inputs are allowed where specified, including leader confirmation, Base Start confirmation/adjustment, Pivot confirmation/adjustment, intended trigger, and trailing SMA10/SMA20 choice.
- Point-in-time decisions must use evidence observable at the relevant historical time. Do not introduce look-ahead data.

## Scope boundaries

For the Quality Profiles feature:

- Use TradeTally's existing market-data abstraction/providers and existing fallbacks.
- Do not add ClickHouse integration.
- Do not add QuantSpace integration.
- Do not add a new external market-data vendor unless the user explicitly changes scope.
- Do not implement screenshot/LLM/CV grading in v1.
- Do not implement arbitrary user JavaScript, Python, SQL, or a general rule DSL.
- Do not invent an automated top-1–2% universe RS score; Canonical BO leader status is a user assertion in v1.
- Preserve legacy Setup Quality data and behavior during migration unless the milestone explicitly replaces a specific path.

## Existing architecture

Backend:

- Node.js >= 20.19
- Express
- PostgreSQL via `pg`
- Jest / Supertest
- Source under `backend/src/`
- Migrations under `backend/migrations/`
- Existing quality logic includes `backend/src/services/tradeQuality.service.js`

Frontend:

- Vue 3
- Vite
- Pinia
- Tailwind CSS
- Vitest
- Source under `frontend/src/`

Package manager:

- pnpm 10.13.1

Follow existing repository patterns before introducing new conventions.

## Database and migration rules

Database work is high risk.

- Inspect the current migration sequence and existing schema before adding a migration.
- Add a new migration; do not rewrite an already-shipped migration unless explicitly instructed.
- Preserve existing production data.
- New Quality Profile versions and completed trade evaluations must be immutable by design where required by the functional specification.
- Migrations must not delete or reset legacy `quality_grade`, `quality_score`, or `quality_metrics` data as part of the initial Quality Profiles implementation.
- Do not execute destructive production database operations.
- Do not use production data as a development sandbox.

## Development and production safety

For risky work such as migrations, calculations, imports, authentication, broker sync, or large refactors, use the isolated development environment described in `docs/CUSTOM_DEVELOPMENT.md`.

Never, unless the user explicitly requests the exact operation:

- run `docker compose down` against the canonical deployment;
- delete, recreate, rename, or copy production PostgreSQL/upload/backup volumes;
- modify production `.env` secrets;
- deploy to HomeLab;
- push or merge branches;
- change `main`.

The canonical production application is rebuilt through the separate HomeLab workflow. Repository implementation tasks should stop after code/tests unless deployment is explicitly requested.

## Testing

Use the smallest relevant test set during implementation, then run the broader affected suite before declaring a milestone complete.

Common commands:

```bash
pnpm install --frozen-lockfile
pnpm --dir backend test
pnpm --dir backend test:integration
pnpm --dir frontend test:run
pnpm --dir frontend build
```

Do not claim tests passed unless they were actually run successfully.

For migrations or code requiring PostgreSQL, use the isolated sandbox described in `docs/CUSTOM_DEVELOPMENT.md` rather than the canonical production database.

## Change discipline

Before editing:

1. Confirm the current branch/worktree is appropriate for `custom` development.
2. Read the relevant requirement and nearby existing implementation/tests.
3. Identify the exact milestone and acceptance criteria.

While editing:

- Prefer focused changes over unrelated refactors.
- Reuse existing services, controllers, market-data abstractions, UI patterns, and test conventions where they fit.
- Keep criterion evaluators modular; do not grow the legacy `tradeQuality.service.js` into a monolithic strategy engine.
- Add or update tests with behavior changes.
- Do not leave fake implementations that return success without evidence.

At completion, report:

- milestone completed;
- files changed;
- migrations added;
- tests/builds run and results;
- requirement items satisfied;
- any `UNKNOWN`/unsupported evidence paths or follow-up work;
- anything intentionally deferred to a later milestone.

## Git policy

- Work on `custom` for custom TradeTally development.
- `main` remains the upstream mirror.
- Normal upstream synchronization is merge-based as documented in `docs/CUSTOM_DEVELOPMENT.md`; do not routinely rebase `custom`.
- Do not commit, push, merge, tag, or rewrite history unless explicitly requested by the user for the current task.
- Never force-push.

## Kilo development workflow

Project-specific Kilo configuration lives under `.kilo/`.

Use `/dev <task>` as the normal lightweight development workflow. The command runs the `developer` agent, which may delegate bounded tasks to `planning`, `research`, and `reviewer` through Kilo's subagent/task mechanism.

Agents:

- `developer` — primary implementation agent and lightweight orchestrator. Project default model: DeepSeek V4 Flash.
- `planning` — read-only implementation planner. Project default model: GLM 4.7 Flash through OpenRouter.
- `research` — read-only repository/external research agent. Project default model: MiniMax M3 through OpenRouter.
- `reviewer` — independent read-only code/requirement reviewer. Project default model: Step 3.7 Flash through OpenRouter.

The project pins model IDs in agent Markdown files, but provider credentials/API keys must remain in the user's global/local Kilo provider configuration and must never be committed to this repository.

The `/dev` workflow is intentionally simple:

```text
scope
  -> planning when non-trivial
  -> targeted research when needed
  -> developer implementation + tests
  -> reviewer
  -> developer fixes + retest
  -> stop and report
```

Do not use Kilo's deprecated dedicated Orchestrator mode for this workflow. Full-tool primary agents can delegate directly to subagents.

The repository also contains `.agents/skills/`; preserve those existing skills and use them when relevant. They are complementary to the Kilo agents above.

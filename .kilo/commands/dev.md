---
description: Run the lightweight TradeTally development workflow: plan, research if needed, implement, test, review, fix, and report one bounded milestone.
agent: developer
---

# /dev

Task:

$ARGUMENTS

Run this as a lightweight development orchestration workflow in the current TradeTally worktree.

1. Read `AGENTS.md` and the relevant project specification/documentation.
2. Define the exact milestone, acceptance criteria, and explicit non-goals from the task above. Ask the user only if a material ambiguity cannot be resolved from repository/spec evidence.
3. For non-trivial work, delegate a bounded plan to the `planning` subagent. Use the returned plan as guidance, not as permission to expand scope.
4. Delegate targeted questions to `research` only when repository discovery or current external documentation is genuinely needed.
5. Implement the milestone as the `developer` agent. Preserve existing repository conventions and legacy behavior unless the milestone explicitly changes them.
6. Run focused tests during implementation and the broader affected tests/build before completion.
7. Delegate the completed diff to `reviewer`. Require review against the current milestone/specification, regression safety, data safety, and tests.
8. Fix all in-scope BLOCKER/HIGH findings and relevant MEDIUM findings. Rerun affected tests. If material fixes were made, request a short reviewer re-check.
9. Stop at the current milestone boundary. Do not automatically continue to another milestone.
10. Do not commit, push, merge, deploy, or touch production data unless the task explicitly requests that operation.

Final report:

- milestone completed;
- files changed;
- migrations/schema/API effects;
- tests/builds run and results;
- reviewer findings resolved/unresolved;
- acceptance criteria satisfied;
- intentional deferrals and evidence limitations.

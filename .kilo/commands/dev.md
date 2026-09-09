---
description: Run the lightweight TradeTally development workflow: plan, research if needed, implement, test, bounded review, fix, targeted re-review, and report one milestone.
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
7. Delegate the completed diff to `reviewer` for a bounded review of the current milestone only. Request only BLOCKER, HIGH, and materially important MEDIUM findings. Do not request LOW/style findings, implementation narration, or a requirement summary. Maximum 10 findings total.
8. Fix all in-scope BLOCKER/HIGH findings and relevant MEDIUM findings, then rerun affected tests.
9. If material fixes were made, request a targeted re-review of only the previously reported findings and the corrective changes. The re-review must not perform a fresh whole-diff audit unless explicitly requested by the user.
10. If the reviewer reports `Review status: CLEAR`, do not invoke it again for the same unchanged diff.
11. Stop at the current milestone boundary. Do not automatically continue to another milestone.
12. Do not commit, push, merge, deploy, or touch production data unless the task explicitly requests that operation.

Final report:

- milestone completed;
- files changed;
- migrations/schema/API effects;
- tests/builds run and results;
- reviewer findings resolved/unresolved;
- acceptance criteria satisfied;
- intentional deferrals and evidence limitations.

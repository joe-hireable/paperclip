# Intelligent routing: quality before speed before cost

This phase adds inspectable, task-scoped routing authority to Paperclip. It does not turn a catalogue claim into an executable route or start work while a decision is previewed or approved.

## Decision contract

- [x] Pin the task family, frozen benchmark and case manifest, rubric, evaluation policy, independent evaluators, required tools/modalities/context, data class and risk.
- [x] Pin the exact harness, account, requested model, expected served model, effort, static delivery mode and effective configuration. The server derives configuration digests from resolved configuration, role permissions and a fresh digest of native runtime artefacts, instructions and profile configuration.
- [x] Require one complete held-out evaluation report. Reject missing, repeated, conflicting or expired reports and evaluator identities outside the trusted control-plane allowlist. Leakage flags and evaluator provenance are attested metadata: the trusted evidence producer must verify them; the selector does not authenticate external evaluators or independently detect semantic leakage. A changed model, effort, instruction policy or benchmark requires new qualification.
- [x] Rank qualified candidates by the 95% Wilson quality lower bound, then nearest-rank p95 total elapsed time, then measured marginal cost. Total elapsed time and cost include review and rework. Unknown values remain unknown. Cost cannot compensate for worse measured quality.
- [x] Require independent frontier review for local-model candidates. A board-approved frontier baseline is a separately labelled fallback, used only when the task explicitly permits it and no measured candidate qualifies. It has no fabricated quality score.

## Board authority and execution

- [x] Provide company-scoped board endpoints for context, preview, append-only contract creation and latest revision. Agent-authored requests cannot lower their own requirements or replace binding definitions.
- [x] Load actual binding definitions from the database. Context returns configuration digests without raw configuration or credentials.
- [x] Serialize creation on the issue row and check the expected input digest and revision. Persist each decision with its author and an activity record. Apply exactly its selected binding in the same transaction; an unqualified decision removes the binding and blocks the task.
- [x] Pin issue input fields, requested workspace policy, linked document revisions/content digests and active human/agent comment content and attribution. Exclude status, the selected binding and the engine's derived execution-workspace identifier. Check effective launch configuration separately.
- [x] Expose a launch guard requiring unchanged scope, assignee, task input, linked documents, selection, effective configuration, permissions, effort and fresh qualification. Return an inspectable receipt; do not claim capacity was reserved.
- [x] Verify acquisition and prelaunch integration against a real disposable database, including concurrent revisions and attempts to remove authority.
- [x] Complete independent review and all required checks before enabling execution.

## HTTP workflow

The base path is `/api/companies/:companyId/issues/:issueId/intelligent-routing`.

1. `GET /context` returns `inputDigest`, `latestRevision`, the assigned agent, linked-document digests and available binding configuration digests.
2. `POST /preview` accepts `expectedInputDigest`, `expectedRevision`, requirements and candidate metadata. It evaluates without writing or waking an agent.
3. `POST /contracts` accepts the same strict payload, appends a revision and applies its exact selection atomically. It never creates a run or promises capacity.
4. `GET /contracts/latest` returns the latest inspectable authority record.

Contracts permit at most 32 candidates, 4,096 case results and 1 MiB of metadata. Task inputs are limited to 100 linked documents, 100 active comments, 1 MiB per body and 8 MiB total. Human and agent comment edits, additions and deletions invalidate the previous input digest. These APIs accept digests and evaluation metadata, not raw training examples. A private training corpus belongs outside source control and outside this contract table.

## Boundaries and acceptance

The existing explicit binding layer supports native Claude Code and Codex subscription profiles. The new intelligent static delivery mode currently qualifies Claude Code through its native safe mode (adapter checks used the locally installed CLI 2.1.257). Native behaviour requires a recorded canary on the exact qualified binary; these adapter checks alone do not prove instruction interpretation. Codex remains discoverable but is rejected for static delivery: its empty MCP table override merges existing configuration, so it cannot prove that ambient tools are disabled. Other harnesses and local-compute adapters remain ineligible until their execution adapters, account boundaries and billing routes are separately qualified. A policy fixture is not evidence that its runtime is deployed or dispatchable.

`static_native` delivery qualifies only text, synthetic arithmetic and native shell/file tasks. Company skills, connection tools and managed MCP delivery require their own complete manifest before they can qualify. Each real native binding must identify the concrete runtime artefacts needed to fingerprint its executable path; a wrapper script alone is insufficient.

Project tasks must select an existing project workspace and realised active local execution workspace, use `reuse_existing`, and retain matching workspace settings without dynamic environment, strategy or runtime overrides. Both workspace rows are company/project-scoped and their critical configuration, status and working directories are hashed. Volatile timestamps are excluded. Projectless tasks require an explicit absolute role working directory. The launch configuration must match the qualified directory; dynamically creating a new worktree requires a subsequent qualification phase.

Availability is an expiring observation; account capacity is reserved atomically by the existing execution-binding service. A stale observation, changed task or changed policy requires a new valid decision. Provider aliases are distinct from the served model identity recorded by an evaluation.

Contracts are retained as immutable history while their task is retained. Explicit task or company deletion cascades to its routing records as part of that authorised purge. Deleting an agent preserves its historical identifier in retained contracts and invalidates future execution through the normal assignee guard. No contract-edit or contract-delete endpoint is introduced.

Task-input digests detect document and comment revisions on creation and before launch. Existing document editing does not acquire the issue routing lock, so this is drift detection, not a permanent input freeze. `loadRoutingTaskInputDigests` is the canonical helper; its compatibility alias `loadRoutingDocumentRevisionDigests` also includes comments. Qualifications are limited to the measured task family and frozen suite; the confidence bound does not establish general intelligence or guarantee future outcomes.

Acceptance requires policy and authority tests, real database race/launch tests, strict checks for shared/server/database packages, and independent review. The first live rollout should remain a bounded synthetic task with an independently reviewed outcome; no production work or paid fallback follows merely from adding the router.

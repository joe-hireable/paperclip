# Port status (2026-11-07)

Branch: `cursor/port-heartbeat-execution-bindings-4ee6`

This records the remaining `doc/port-notes` items against backup
`backup/pre-upstream-rebase-20261106` after the upstream rebase.

## Ported

- Heartbeat bound-execution recovery: pre-drain and release-recovery treat a
  `run_execution_bindings` row as a finite explicit attempt. Bound notice
  `bound_execution_attempt` outranks review-participant retry.
- Project conversation context-only origins (`project_master_chat`,
  `project_coordinator_intake`) skip queued wakeup, claim, and bounded retry
  (`project_master_context_only`). Coordinator attempts
  (`project_coordinator_attempt`) go through `assertCoordinatorRunAdmission`
  on wakeup, claim, and execute.
- Modular `executeRun` / `executeHeartbeatRuntime` now carry the backup
  coordinator execute path: refuse context-only runs, admit
  `manifest_coordinator`, skip provider-trace, mint a
  `project_coordinator` JWT, prepare/verify the coordinator
  manifest, then `assertBeforeLaunch` at the locked dispatch gate.
  Routing receipts skip runtime skill materialization (so local-path
  inventory reconcile cannot delete pinned coordinator skills), skip
  pending workspace mutation, skip runtime tools/MCP, and call
  `assertStaticIntelligentRoutingDelivery` at dispatch. Terminal
  coordinator attempts `settle` after execute cleanup and on
  `resumeQueuedRuns`, then `projectCoordinatorProgressionService.recover`
  can start specialist children.
- `MarkdownBody` UUID issue links resolve `/issues/<uuid>` to
  `/issues/<identifier>` while keeping query and fragment.
- Missing-comment retry is suppressed when a run execution binding exists.
- Owned process-group cancellation (`signalOwnedGroup`) and its process-recovery
  tests.
- MCP tool-gateway `isError` / `mcp_tool_error` persistence, replay, `gatewayId`
  on invocation/event writes (including virtual `search_tools`), and
  gateway-scoped approved-action lookup/`action_scope_mismatch`. Provider MCP
  `isError` results are persisted as `mcp_tool_error` (HTTP 200) rather than
  thrown as `tool_error` (HTTP 502); `normalizeMcpToolResult` still adds an
  `error` field for GitHub access-denied, which remains a 403.
- Durable-account migration fixture reads `0441_complex_sunfire.sql` (Joe's
  `0243_complex_sunfire` after journal rebase).
- Idempotency isolates **named** MCP gateways. An unnamed heartbeat session and
  the same run's Paperclip runtime MCP gateway may replay one invocation
  (assigned-tool recovery). Two named gateways still conflict. System-actor
  derived side-effect keys hash `companyId` as `actorId` so two named-gateway
  tokens cannot execute the same write twice.
- UI master intake: `IssueChatThread`, `TaskChatThread`, `TaskChatComposer`,
  `IssueDetail` notice/retry envelope, `PendingIntakeError` draft handling.
- UI execution binding: `NewIssueDialog`, `IssueProperties`, `IssueDetail`
  requalify/invalidation, `AgentDetail` restart block and run details.
- Heartbeat execution-binding integration suite is active (no longer deferred).
  The fixture now seeds a `test-board` user and company memberships, matching
  other embedded-Postgres suites.
- Final locked dispatch gate re-checks `assertUnboundAllowed` / `assertBeforeLaunch`
  so a late instance-wide registration or expired qualification cannot reach the
  adapter. Those re-checks run *inside* the ownership-gate callback after it
  sets `entered`, so an async binding assert cannot mark captured usage as
  pre-provider (`accountingProviderWorkStarted: false`) and skip the ledger.
- Paid-API bindings overlay `billingType: api` and the account-key biller onto
  adapter usage before ledger capture.

## Intentionally adapted to upstream structure

- Unbound adapter failures schedule a delayed `scheduled_retry` (30s/60s) instead
  of an immediate second dispatch. The integration test asserts the scheduled
  successor exists rather than waiting out the delay.
- Unbound in-review recovery follows upstream review-participant policy: after
  the recovery retry, the issue is blocked. Backup left the issue `in_review`.
- Usage `costStatus` follows upstream ledger rules (`subscription_included` is
  `reported` even when adapter `costUsd` is null). `costUsd: null` may be stored
  explicitly.

## Fork-only tests not present on upstream `3381d56639`

- `project-coordinator-attempts.test.ts` is fork-only. The modular execute
  path now matches backup: ordinary auto-start, specialist handoff, pre-spawn
  drift (including `role_config` via `assertBeforeLaunch`), and specialist
  own-role execution.
- `heartbeat-project-conversations.test.ts` adoption-race cases wait on the
  same issue `FOR UPDATE` as `projectConversationService.ensure`, then recheck
  `originKind` before insert/claim.
- `intelligent-routing-execution.test.ts` heartbeat cases are fork-only. Bound
  receipts no longer run `applyPendingTaskWorkspaceSelection` (that mutation
  made project-less issues fail `loadRoutingTaskInputDigests`). Adapter
  `intelligent_routing_instructions_unavailable` maps through
  `executionBindingOrRoutingErrorCode` instead of collapsing to
  `adapter_failed`.

## Live switch

See `doc/port-notes/LIVE-SWITCH.md`. `pnpm db:live-switch` remaps Joe
0240–0247 hashes/names onto 0438–0445 without re-applying them, applies
upstream 0240–0437, and skips plugin schema
`plugin_shared_operations_6f6f8a1ee6` when it already exists.

## Port-note adaptations after rebase verification

- Context-only retry looks up `issues.originKind` through the injected
  `getIssueOriginKind` callback so retry unit tests stay callback-only.
- Named-gateway listing caches `resolveCompanyGatewayId` on the shared
  decision cache. Passing `runContext.gatewayId` into every listing decision
  otherwise queries once per catalog tool.
- Owned process groups always receive `SIGTERM`. Codex still uses `SIGINT`
  only for the numeric child fallback.
- Graceful drain rethrows `owned_process_group_cleanup_incomplete` so shutdown
  cannot report success while an owned group is still live.
- Named-gateway JSON-RPC `tools/call` returns `{ content, isError: true }`
  for persisted MCP `isError` results (no transport `structuredContent`
  wrapper). GitHub access-denied remains HTTP 403. Upstream's
  `preserves provider tool errors…` case now asserts `mcp_tool_error`
  instead of thrown `tool_error`.

## Full `pnpm test:run` vs `3381d56639` (Node v24.22.2)

Both heads ran the same local `pnpm test:run` layout (chat shards, then
serial general-server, then workspaces-a/b/c, then serialized). Local
`run-vitest-stable` aborts a group on the first failed project, so remaining
groups were continued separately after a general-server abort.

Shared on both heads (timeouts, host git contention, missing `cursor-agent`,
Cargo 1.83 / `edition2024`, missing runner linux-x64 daemon): workspace
runtime/expiration/rehome/trust suites, `execution-workspaces-service`
close-readiness, `plugin-runner-probe` / `native-usage-delivery`,
`cursor-local-*`, adapter-utils git-workspace-sync 5s timeouts, and
`company-portability` serialized git metadata.

HEAD-only (port or fork-only, not timeouts):

- `tool-gateway-service` Google Workspace preview: MCP `isError` now
  returns `{ isError: true }` (`mcp_tool_error`) instead of throwing
  `tool_error`. Intentional; 3381 still throws.
- Fork-only coordinator files: `coordinator-delivery` (instruction-bundle
  prompt wrap), `project-coordinator-intake` (404 vs 403), `redaction`
  public `authorityDigest`.
- `packages/db` snapshot drift: newest snapshot is still `0437_*`; Joe
  tables live in `0438`–`0445`. Do not generate a new core migration.
- CLI `worktree.test.ts`: `CREATE INDEX CONCURRENTLY` in Joe `0438`–`0445`
  cannot run inside drizzle's migrate transaction. Live-switch remaps those
  hashes and does not re-apply them. 3381 does not have those files.
- UI AgentDetail crash on a missing binding snapshot is fixed on this head.

Targeted fork-only execute-path suites on this head: coordinator 98/98,
project-conversations 11/11, intelligent-routing-execution 32/32,
MarkdownBody 60/60, live-switch throwaway DB 1/1.

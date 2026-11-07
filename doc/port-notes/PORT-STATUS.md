# Port status (2026-11-07)

Branch: `cursor/port-heartbeat-execution-bindings-4ee6`

This records the remaining `doc/port-notes` items against backup
`backup/pre-upstream-rebase-20261106` after the upstream rebase.

## Ported

- Heartbeat bound-execution recovery: pre-drain and release-recovery treat a
  `run_execution_bindings` row as a finite explicit attempt. Bound notice
  `bound_execution_attempt` outranks review-participant retry.
- Project conversation context-only origins (`project_master_chat`,
  `project_coordinator_intake`, `project_coordinator_attempt`) skip queued
  wakeup and bounded retry (`project_master_context_only`).
- Missing-comment retry is suppressed when a run execution binding exists.
- Owned process-group cancellation (`signalOwnedGroup`) and its process-recovery
  tests.
- MCP tool-gateway `isError` / `mcp_tool_error` persistence and replay.
- UI master intake: `IssueChatThread`, `TaskChatThread`, `TaskChatComposer`,
  `IssueDetail` notice/retry envelope, `PendingIntakeError` draft handling.
- UI execution binding: `NewIssueDialog`, `IssueProperties`, `IssueDetail`
  requalify/invalidation, `AgentDetail` restart block and run details.
- Heartbeat execution-binding integration suite is active (no longer deferred).
  The fixture now seeds a `test-board` user and company memberships, matching
  other embedded-Postgres suites.
- Final locked dispatch gate re-checks `assertUnboundAllowed` / `assertBeforeLaunch`
  so a late instance-wide registration or expired qualification cannot reach the
  adapter.
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

## Intentionally not inlined into modular `executeRun`

- Backup `heartbeat.ts` inlined `assertCoordinatorRunAdmission`,
  `prepareCoordinatorDelivery`, and `verifyCoordinatorInvocation` inside the
  monolith execute path. Those services already exist on this branch
  (`project-coordinator-attempts.ts`, `coordinator-delivery.ts`) with their own
  tests. Upstream heartbeat is modular and already special-cases
  `project_coordinator_attempt` through intelligent-routing contracts
  (`deliveryMode: manifest_coordinator`). Re-inlining the backup execute-path
  blocks would be a large structural merge, not a faithful module-level port.
  Dedicated coordinator tests remain the coverage. **Live risk:** if the
  running instance depends on heartbeat execute-path coordinator admission and
  manifest delivery (not only the dedicated services/tests), compare that path
  before switching.

## Previously deferred / not in the remaining list

- `MarkdownBody` UUID issue-link resolution remains unported. Upstream
  MarkdownBody does not have that resolver; the UI test is marked
  `PORT-DEFERRED`.

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

## Fork-only tests not present on upstream `3381d56639`

- `project-coordinator-attempts.test.ts` (98 cases, 82 currently failing): not
  in the remaining `doc/port-notes` list. Prepare is idempotent only when the
  captured `projectContext` hashes identically; the second `prepare()` in the
  snapshot test currently returns no `authorityDigest` (digest mismatch /
  conflict). Not inlined into modular `executeRun` (see above). Live switch
  should compare coordinator prepare/admit against the running instance.
- `heartbeat-project-conversations.test.ts` admission-race cases
  (`serializes admission behind actual adoption…`, `rechecks a legacy queued
  insertion racing adoption…`) still fail: a concurrent `invoke`/`resume`
  is not held behind `projectConversationService.ensure`'s open transaction.
  Ordinary master suppression, bounded-retry skip, and unbound issue dispatch
  pass. Same structural gap as the non-inlined execute-path coordinator
  admission. The fixture now seeds `authUsers` + active membership for
  `fixture-board` (same class of gap as `test-board` on the binding suite).
- `intelligent-routing-execution.test.ts` heartbeat cases are fork-only. The
  fixture now seeds `synthetic-board` membership. Remaining failures are
  upstream workspace-routing (`Tasks without a project require a fixed role
  working directory…`) and adapter-throw codes flattening to `adapter_failed`.
  The dispatch-time binding gate is covered by
  `heartbeat-execution-bindings.test.ts`.

## Previously deferred / not in the remaining list

- `MarkdownBody` UUID issue-link resolution remains unported. Upstream
  MarkdownBody does not have that resolver; the UI test is marked
  `PORT-DEFERRED`.

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

## Migrations

No new core DB migrations were added by this port. Drizzle keys Joe's
0240–0247 SQL by content hash, so those files already sit at 0438–0445 on
this branch. A database at the backup-branch schema already has those hashes
applied; migrating to this head applies upstream 0240–0437 as new pending
files. Plugin `plugin-shared-operations` migration `001_company_state.sql`
(schema `plugin_shared_operations_6f6f8a1ee6`) is preserved. Do not
re-CREATE that plugin table on a live instance that already has it.

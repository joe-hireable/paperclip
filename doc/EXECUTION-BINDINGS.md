# Optional task execution bindings

Execution bindings separate an organisational agent's role from the harness,
authenticated native account and model used for one task attempt. This first
slice supports explicit, qualified local Claude Code and Codex CLI bindings.
It does not infer permissions or task requirements from a title.

The ordinary agent adapter path remains available. Set an agent's
`runtimeConfig.executionBindingRequired` to `true` when every task for that role
must use a binding. A heartbeat without a qualified task binding then stops
before dispatch. Participating roles must enable this flag to prevent their
default adapter from bypassing account reservations. Standalone harness sessions
outside Paperclip are not controlled by these reservations.

## Board setup and selection

All endpoints below require board access to the company. Binding definitions are
immutable: create a replacement and disable the old definition when its native
profile, qualification or model changes. There is no credential upload endpoint.

- `GET /api/companies/:companyId/execution-bindings`: list definitions.
- `POST /api/companies/:companyId/execution-bindings`: create a definition.
- `POST /api/companies/:companyId/execution-bindings/:bindingId/disable`: prevent
  future acquisitions; the current run keeps its original snapshot.
- `POST /api/companies/:companyId/execution-bindings/preview`: evaluate
  `{agentId, requirements}` against current definitions. Requirements contain an
  exact model, required capabilities, data class, reason, evidence references and
  an explicit preference order (`preferredBindingIds`, which may be empty).
  The response records exclusions, stable selection, unknown quota and
  `capacityReserved: false`. A preview neither starts work nor reserves capacity.

A definition contains `name`, `accountKey`, `adapterType` (`claude_local` or
`codex_local`), an absolute `command` and `nativeProfileHome`, `models` containing
exactly one qualified model, `capabilities`, `dataClasses` (`public`, `synthetic`
or `private`), `allowedAgentIds`, `billingRoute: "native_subscription"`,
`evidenceRefs` and a current `verifiedUntil` timestamp. Qualification is operator
evidence, not an automatic account-entitlement or model-quality measurement.

Use the same company-scoped `accountKey` for every binding sharing an underlying
native account, including separate model bindings. The service rejects a second
capacity key for the same declared harness/profile path. Operators must also
group aliases or separate profile directories authenticated to the same account;
the server does not inspect or copy authentication tokens to infer identity.

Persist a preview's `selection` on the task as
`assigneeAdapterOverrides.executionBinding`. A selected binding is allowed only
for the task's assigned role and company. Bound tasks may still set
`useProjectWorkspace`, but may not supply arbitrary `adapterConfig` overrides.
Workspace settings and the role's managed instruction bundle remain the normal
Paperclip sources of task context.

## Native execution

At dispatch, the server locks the task, validates scope, role, qualification
expiry, exact model capabilities and permitted data class, then reserves the
account atomically across roles. Each account currently has capacity one. A
partial unique database index backs the account lock. Busy capacity stops the
attempt visibly; it does not change account, model or billing route.

The immutable run snapshot records the selected binding, task requirements,
reason, evidence references, effective non-secret adapter configuration and
session key. Role ID, permissions, reporting line, checkout and author attribution
stay with the original agent. Native `CODEX_HOME` or `CLAUDE_CONFIG_DIR` is
projected before credential readiness checks, and `engine: "cli"` is explicit.
Role instructions, execution limits, containment settings and the two central
Shared Operations policy references are preserved. Prior harness environment,
arguments and session defaults are not copied into the new account.
The source role's explicit permission-bypass choice is translated to the target
harness, so switching to Claude cannot apply its more permissive default.
Claude with `filesystemScope: "workspace"` currently stops before acquisition:
that adapter replaces an explicit profile with the ambient shared profile during
confinement. A separate adapter fix is needed before qualifying that combination.

The selected command, engine, model and native profile are checked before
credential preparation and again before dispatch. Project, routine or environment
configuration cannot silently substitute another account after reservation.
Provider API/auth overrides in the resolved or ambient environment are rejected.
The operator must qualify the native profile itself as subscription authenticated;
this slice does not parse every harness-specific login helper or settings file.

Task sessions are scoped by company, role, task, immutable binding, account,
harness and model. An unqualified native session override cannot cross that
boundary. Automatic retry/native-runner recovery of a bound run is deliberately
unsupported in this first slice and stops visibly for reconciliation. New direct
local attempts may use their matching saved task session.

## Inspecting and reconciling runs

`GET /api/companies/:companyId/runs/:runId/execution-binding` returns the snapshot
and reservation state to the board. The run activity log also records acquisition
and the selection reason. Controller ownership capabilities are omitted from API
responses. No telemetry event or external data export is added.

Account capacity is released after execution teardown only when the run is
terminal, the owning execution has settled and every durably observed process
group is gone. Native session-retry attempts append process evidence; a later
attempt never erases an earlier process tree.
A status update, timeout or server restart alone cannot release it. A launch with
missing process evidence retains capacity. This process-group proof is intended
for the supported local POSIX/WSL CLI process path; it is not a cloud recovery
protocol or universal Windows process-tree controller.

After a controller crash, the board may call
`POST /api/companies/:companyId/runs/:runId/execution-binding/reconcile` with
`{checkpointRef, pendingEffectsReviewed: true}`. The server also requires the old
controller PID and durable process group to be gone and the run terminal. Live
or ambiguous process state is rejected. Missing durable process evidence remains
an operator repair case; the API cannot manufacture proof that no process started.
The checkpoint must record pending external effects before a new task attempt.

## Deliberate first-slice limits

- No automatic planner, quota polling, measured quality scoring or provider-limit
  rotation. Explicit ordered preferences are applied only after qualification.
- No cloud, Cursor, Grok, GrokBot, local-model or paid API binding dispatch yet.
- No automatic process-loss retry, checkpoint transfer across different bindings,
  general capacity queue or automatic orphan takeover.
- No new frontend management page. The board API, typed UI client and activity
  records expose the initial integration; dedicated routing UI is follow-up work.
- Passing deterministic adapters and database tests is not proof of native
  subscription authentication. An isolated native Claude/Codex run must verify
  actual model output, policy receipt, role attribution and reservation teardown
  before enabling production roles.

## Rollback

Pause opted-in roles and let running processes finish. Disable their bindings,
remove task binding selections and set `executionBindingRequired` back to false
only when their ordinary default adapters are ready. Keep migration tables and
snapshots for history. Do not drop a held reservation or delete its run to free
capacity while the original process may still be alive.

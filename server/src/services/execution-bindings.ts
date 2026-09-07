import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { envBindingPlainSchema } from "@paperclipai/shared";
import {
  agents,
  executionBindings,
  heartbeatRuns,
  issues,
  runExecutionBindings,
  type Db,
} from "@paperclipai/db";
import {
  createExecutionBindingSchema,
  executionBindingSelectionSchema,
  type ExecutionBinding,
  type ExecutionBindingDefinition,
  type ExecutionBindingSelection,
  type ExecutionBindingSnapshot,
} from "@paperclipai/shared/execution-bindings";
import { conflict, notFound, unprocessable } from "../errors.js";
import { persistActivity, type LogActivityInput } from "./activity-log.js";
import {
  assertIntelligentRoutingContract,
  loadLatestIntelligentRoutingContract,
  loadRoutingDocumentRevisionDigests,
} from "./intelligent-routing-contracts.js";
import { intelligentRoutingDigest } from "./intelligent-routing-policy.js";
import { collectIntelligentRoutingRuntimeFingerprint } from "./intelligent-routing-runtime.js";

type Agent = typeof agents.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];
const ROLE_CONFIG_KEYS = [
  "instructionsRootPath",
  "instructionsFilePath",
  "instructionsSource",
  "instructionsEntryFile",
  "instructionsBundleMode",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "cwd",
  "timeoutSec",
  "graceSec",
  "maxTurnsPerRun",
  "outputInactivityTimeoutMs",
  "networkScope",
  "networkAllowlist",
  "filesystemScope",
  "filesystemExtraPaths",
  "dangerouslySkipPermissions",
  "dangerouslyBypassApprovalsAndSandbox",
] as const;

export class ExecutionBindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function deny(code: string, message: string): never {
  throw new ExecutionBindingError(code, message);
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function bindingView(
  row: typeof executionBindings.$inferSelect,
): ExecutionBinding {
  return {
    ...row.definition,
    id: row.id,
    companyId: row.companyId,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export function assertExecutionBindingConfig(
  snapshot: ExecutionBindingSnapshot,
  config: Record<string, unknown>,
  ambientEnv: Record<string, unknown> = {},
) {
  const env = object(config.env);
  const homeKey =
    snapshot.binding.adapterType === "codex_local"
      ? "CODEX_HOME"
      : "CLAUDE_CONFIG_DIR";
  const otherHomeKey =
    homeKey === "CODEX_HOME" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const bypassKey =
    snapshot.binding.adapterType === "claude_local"
      ? "dangerouslySkipPermissions"
      : "dangerouslyBypassApprovalsAndSandbox";
  const effortKey =
    snapshot.binding.adapterType === "codex_local"
      ? "modelReasoningEffort"
      : "effort";
  if (
    config.command !== snapshot.binding.command ||
    config.model !== snapshot.selection.model ||
    config.engine !== "cli" ||
    config.intelligentRoutingDeliveryMode !== snapshot.adapterConfig.intelligentRoutingDeliveryMode ||
    env[homeKey] !== snapshot.binding.nativeProfileHome ||
    env[otherHomeKey] != null ||
    config[bypassKey] !== snapshot.adapterConfig[bypassKey] ||
    config[effortKey] !== snapshot.binding.reasoningEffort ||
    ["effort", "modelReasoningEffort", "reasoningEffort"].some(
      (key) => key !== effortKey && config[key] !== undefined,
    )
  ) {
    deny(
      "execution_binding_config_changed",
      "Execution configuration no longer matches the reserved account, harness, model and reasoning effort",
    );
  }
  for (const key of [
    "PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID",
    "PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST",
  ]) {
    const expected = object(snapshot.adapterConfig.env)[key];
    if (expected !== undefined && env[key] !== expected) {
      deny(
        "execution_binding_config_changed",
        "The role's central policy reference changed after reservation",
      );
    }
  }
  if (
    ["extraArgs", "args", "codexHome", "sessionId"].some(
      (key) => config[key] != null,
    )
  ) {
    deny(
      "execution_binding_config_changed",
      "Bound execution cannot inject alternate CLI arguments or native sessions",
    );
  }
  const effectiveEnv = { ...ambientEnv, ...env };
  if (
    Object.keys(effectiveEnv).some(
      (key) =>
        /^(CODEX_API_KEY|OPENAI_|ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|AZURE_OPENAI)/.test(
          key,
        ) &&
        effectiveEnv[key] != null &&
        effectiveEnv[key] !== "",
    )
  ) {
    deny(
      "execution_binding_billing_denied",
      "Provider API or ambient authentication overrides are incompatible with this native subscription binding",
    );
  }
}

export function resolveExecutionBindingSnapshot(input: {
  binding: ExecutionBinding;
  selection: ExecutionBindingSelection;
  agent: Agent;
  taskKey: string;
  now?: Date;
  deliveryMode?: "static_native";
}): ExecutionBindingSnapshot {
  const { binding, selection, agent } = input;
  const now = input.now ?? new Date();
  // Validate persisted records as well as HTTP input: malformed policy cannot
  // silently select another account, unsupported harness or billing route.
  createExecutionBindingSchema.parse(
    Object.fromEntries(
      Object.entries(binding).filter(
        ([key]) => !["id", "companyId", "enabled", "createdAt"].includes(key),
      ),
    ),
  );
  executionBindingSelectionSchema.parse(selection);
  if (
    binding.companyId !== agent.companyId ||
    selection.bindingId !== binding.id
  )
    deny(
      "execution_binding_scope",
      "Execution binding is outside this company",
    );
  if (!binding.enabled)
    deny("execution_binding_disabled", "Execution binding is disabled");
  if (!binding.allowedAgentIds.includes(agent.id))
    deny(
      "execution_binding_role_denied",
      "This role is not permitted to use the execution binding",
    );
  if (Date.parse(binding.verifiedUntil) <= now.getTime())
    deny(
      "execution_binding_evidence_expired",
      "Execution binding evidence has expired",
    );
  if (!binding.models.includes(selection.model))
    deny(
      "execution_binding_model_denied",
      "Model is not qualified for this binding",
    );
  if (
    selection.requiredCapabilities.some(
      (capability) => !binding.capabilities.includes(capability),
    )
  )
    deny(
      "execution_binding_capability_denied",
      "Execution binding lacks a required capability",
    );
  if (!binding.dataClasses.includes(selection.dataClass))
    deny(
      "execution_binding_data_denied",
      "Execution binding does not permit this data class",
    );
  const roleConfig = object(agent.adapterConfig);
  if (
    binding.adapterType === "claude_local" &&
    roleConfig.filesystemScope === "workspace"
  ) {
    deny(
      "execution_binding_profile_scope_unsupported",
      "Claude filesystem confinement currently replaces the explicit native profile; this combination is not qualified",
    );
  }
  const adapterConfig: Record<string, unknown> = {
    engine: "cli",
    ...(input.deliveryMode ? { intelligentRoutingDeliveryMode: input.deliveryMode } : {}),
    env: {
      [binding.adapterType === "codex_local"
        ? "CODEX_HOME"
        : "CLAUDE_CONFIG_DIR"]: binding.nativeProfileHome,
    },
  };
  const sharedPolicyEnv = object(roleConfig.env);
  for (const key of [
    "PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID",
    "PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST",
  ]) {
    if (Object.hasOwn(sharedPolicyEnv, key)) {
      const raw = sharedPolicyEnv[key];
      const plain = envBindingPlainSchema.strict().safeParse(raw);
      const value =
        typeof raw === "string" ? raw : plain.success ? plain.data.value : null;
      if (value === null)
        deny(
          "execution_binding_policy_reference_invalid",
          "Central policy references must be non-secret string identifiers",
        );
      object(adapterConfig.env)[key] = value;
    }
  }
  for (const key of ROLE_CONFIG_KEYS)
    if (Object.hasOwn(roleConfig, key)) adapterConfig[key] = roleConfig[key];
  // Credentials, arbitrary CLI arguments, model defaults and provider endpoints
  // from the role's default harness must never leak into another account.
  adapterConfig.command = binding.command;
  adapterConfig.model = selection.model;
  // Omitted legacy effort uses the native default. Never carry a role's effort
  // or Codex's legacy alias into a different model/account/harness binding.
  if (binding.reasoningEffort !== undefined) {
    adapterConfig[
      binding.adapterType === "codex_local" ? "modelReasoningEffort" : "effort"
    ] = binding.reasoningEffort;
  }
  // The harnesses have different defaults. Never turn absent/false Codex
  // bypass into Claude's implicit true when a role changes execution harness.
  const sourceBypass =
    agent.adapterType === "claude_local"
      ? roleConfig.dangerouslySkipPermissions === true
      : agent.adapterType === "codex_local"
        ? typeof roleConfig.dangerouslyBypassApprovalsAndSandbox === "boolean"
          ? roleConfig.dangerouslyBypassApprovalsAndSandbox
          : roleConfig.dangerouslyBypassSandbox === true
        : false;
  adapterConfig[
    binding.adapterType === "claude_local"
      ? "dangerouslySkipPermissions"
      : "dangerouslyBypassApprovalsAndSandbox"
  ] = sourceBypass;
  const sessionDigest = createHash("sha256")
    .update(
      JSON.stringify([
        binding.companyId,
        agent.id,
        binding.id,
        binding.accountKey,
        binding.adapterType,
        selection.model,
        input.taskKey,
      ]),
    )
    .digest("hex");
  return {
    version: 1,
    binding,
    selection,
    adapterConfig,
    sessionKey: `binding:${sessionDigest}`,
    resolvedAt: now.toISOString(),
  };
}

export function executionBindingService(db: Db, options: {
  runtimeFingerprint?: typeof collectIntelligentRoutingRuntimeFingerprint;
} = {}) {
  const runtimeFingerprint = options.runtimeFingerprint ?? collectIntelligentRoutingRuntimeFingerprint;
  // Boot-local ownership is a capability. A restarted server may inspect an
  // existing reservation but cannot reclaim it by run ID or elapsed time.
  const ownerId = `${process.pid}:${randomUUID()}`;
  async function getRunBinding(companyId: string, runId: string) {
    return db
      .select()
      .from(runExecutionBindings)
      .where(
        and(
          eq(runExecutionBindings.companyId, companyId),
          eq(runExecutionBindings.runId, runId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }
  async function list(companyId: string) {
    return db
      .select()
      .from(executionBindings)
      .where(eq(executionBindings.companyId, companyId))
      .then((rows) => rows.map(bindingView));
  }
  async function create(
    companyId: string,
    input: ExecutionBindingDefinition,
    activity: Omit<
      LogActivityInput,
      "companyId" | "action" | "entityType" | "entityId"
    >,
  ) {
    const definition = createExecutionBindingSchema.parse(input);
    if (Date.parse(definition.verifiedUntil) <= Date.now())
      throw unprocessable("Binding qualification must be current");
    return db.transaction(async (tx) => {
      // Canonical grouping is board-owned, but the same declared profile must
      // not accidentally acquire independent capacity under a second key.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`execution-binding-definition:${companyId}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(executionBindings)
        .where(eq(executionBindings.companyId, companyId));
      if (
        existing.some(
          (row) =>
            row.definition.adapterType === definition.adapterType &&
            row.definition.nativeProfileHome === definition.nativeProfileHome &&
            row.definition.accountKey !== definition.accountKey,
        )
      )
        throw conflict(
          "This native profile already belongs to another account capacity group",
        );
      const permitted = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            inArray(agents.id, definition.allowedAgentIds),
          ),
        );
      if (
        new Set(permitted.map((agent) => agent.id)).size !==
        new Set(definition.allowedAgentIds).size
      )
        throw unprocessable("Allowed roles must belong to this company");
      const [row] = await tx
        .insert(executionBindings)
        .values({ companyId, definition })
        .returning();
      await persistActivity(tx as unknown as Db, {
        ...activity,
        companyId,
        action: "execution_binding.created",
        entityType: "execution_binding",
        entityId: row!.id,
        details: {
          name: definition.name,
          adapterType: definition.adapterType,
          accountKey: definition.accountKey,
        },
      });
      return bindingView(row!);
    });
  }
  async function disable(
    companyId: string,
    id: string,
    activity: Omit<
      LogActivityInput,
      "companyId" | "action" | "entityType" | "entityId"
    >,
  ) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(executionBindings)
        .set({ enabled: false })
        .where(
          and(
            eq(executionBindings.companyId, companyId),
            eq(executionBindings.id, id),
          ),
        )
        .returning();
      if (!row) throw notFound("Execution binding not found");
      await persistActivity(tx as unknown as Db, {
        ...activity,
        companyId,
        action: "execution_binding.disabled",
        entityType: "execution_binding",
        entityId: id,
      });
      return bindingView(row);
    });
  }

  async function acquire(
    run: Run,
    agent: Agent,
  ): Promise<ExecutionBindingSnapshot | null> {
    const context = object(run.contextSnapshot);
    const issueId =
      typeof context.issueId === "string" ? context.issueId : null;
    const existing = await getRunBinding(run.companyId, run.id);
    if (existing)
      deny(
        "execution_binding_reconciliation_required",
        "A previous execution owns this run binding; reconcile it before a new attempt",
      );
    const sourceRunId =
      run.retryOfRunId ??
      (typeof context.resumeFromRunId === "string"
        ? context.resumeFromRunId
        : null);
    if (sourceRunId && (await getRunBinding(run.companyId, sourceRunId)))
      deny(
        "execution_binding_reconciliation_required",
        "Automatic retry or explicit native resume of a bound run is not supported; use a reconciled new task attempt",
      );
    const bindingRequired =
      object(agent.runtimeConfig).executionBindingRequired === true;
    if (!issueId) {
      if (bindingRequired)
        deny(
          "execution_binding_required",
          "This role requires a qualified task execution binding",
        );
      return null;
    }
    return db.transaction(async (tx) => {
      // Issue lock pins assignment and selected binding for this attempt.
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .for("update");
      if (!issue) deny("execution_binding_scope", "The task is unavailable in this company");
      const overrides = object(issue?.assigneeAdapterOverrides);
      const routingContract = await loadLatestIntelligentRoutingContract(
        tx as unknown as Db, run.companyId, issueId,
      );
      if (!Object.hasOwn(overrides, "executionBinding")) {
        if (bindingRequired || routingContract)
          deny(
            "execution_binding_required",
            "This role requires a qualified task execution binding",
          );
        return null;
      }
      if (issue?.assigneeAgentId !== agent.id)
        deny(
          "execution_binding_role_denied",
          "Execution binding belongs to the task's current assignee",
        );
      if (run.runtimeMode === "native" || run.retryOfRunId)
        deny(
          "execution_binding_reconciliation_required",
          "Only a new direct local run can acquire an execution binding",
        );
      if (Object.keys(object(overrides.adapterConfig)).length)
        deny(
          "execution_binding_override_denied",
          "Bound tasks cannot override adapter configuration; select another qualified binding instead",
        );
      if (
        [
          "resumeSessionParams",
          "resumeSessionDisplayId",
          "resumeFromRunId",
        ].some((key) => context[key] != null)
      )
        deny(
          "execution_binding_resume_denied",
          "Bound tasks cannot accept an unqualified native session override",
        );
      const selection = executionBindingSelectionSchema.parse(
        overrides.executionBinding,
      );
      const [row] = await tx
        .select()
        .from(executionBindings)
        .where(
          and(
            eq(executionBindings.id, selection.bindingId),
            eq(executionBindings.companyId, run.companyId),
          ),
        )
        .for("update");
      if (!row)
        deny(
          "execution_binding_scope",
          "Execution binding is unavailable in this company",
        );
      const snapshot = resolveExecutionBindingSnapshot({
        binding: bindingView(row),
        selection,
        agent,
        taskKey: issueId,
        ...(routingContract ? { deliveryMode: "static_native" as const } : {}),
      });
      if (routingContract) {
        const [currentAgent] = await tx.select().from(agents).where(and(
          eq(agents.id, agent.id), eq(agents.companyId, run.companyId),
        ));
        if (!currentAgent || intelligentRoutingDigest({ config: currentAgent.adapterConfig, permissions: currentAgent.permissions }) !==
          intelligentRoutingDigest({ config: agent.adapterConfig, permissions: agent.permissions })) {
          deny("intelligent_routing_role_changed", "Role configuration changed after this run was prepared");
        }
        snapshot.routingReceipt = assertIntelligentRoutingContract({
          contract: routingContract, issue: issue!, agent: currentAgent,
          binding: bindingView(row), snapshot, now: new Date(),
          documentRevisionDigests: await loadRoutingDocumentRevisionDigests(tx as unknown as Db, run.companyId, issueId),
          runtimeFingerprint: await runtimeFingerprint({ adapterConfig: snapshot.adapterConfig, binding: snapshot.binding, runtimeFilePaths: snapshot.binding.runtimeFilePaths }),
        });
        snapshot.routingAuthorityDigest = intelligentRoutingDigest({ config: currentAgent.adapterConfig, permissions: currentAgent.permissions });
      }
      // This lock serialises different bindings/roles backed by the same native
      // account. The partial unique index is the second database guard.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${run.companyId}:${snapshot.binding.accountKey}`}, 0))`,
      );
      const [held] = await tx
        .select({ runId: runExecutionBindings.runId })
        .from(runExecutionBindings)
        .where(
          and(
            eq(runExecutionBindings.companyId, run.companyId),
            eq(runExecutionBindings.accountKey, snapshot.binding.accountKey),
            isNull(runExecutionBindings.releasedAt),
          ),
        );
      if (held)
        deny(
          "execution_binding_capacity_busy",
          `Account capacity is reserved by run ${held.runId}; no fallback was started`,
        );
      const [lockedRun] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.agentId, agent.id),
          ),
        )
        .for("update");
      if (!lockedRun || lockedRun.status !== "running")
        deny(
          "execution_binding_run_not_running",
          "Run is no longer eligible for execution",
        );
      await tx.insert(runExecutionBindings).values({
        runId: run.id,
        companyId: run.companyId,
        bindingId: row.id,
        accountKey: snapshot.binding.accountKey,
        snapshot,
        ownerId,
      });
      await persistActivity(tx as unknown as Db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "system",
        agentId: agent.id,
        runId: run.id,
        action: "execution_binding.acquired",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: {
          bindingId: row.id,
          adapterType: snapshot.binding.adapterType,
          model: selection.model,
          accountKey: snapshot.binding.accountKey,
          reason: selection.reason,
          evidenceRefs: selection.evidenceRefs,
        },
      });
      return snapshot;
    });
  }

  async function recordProcess(
    runId: string,
    meta: { pid: number; processGroupId: number | null },
  ) {
    await db
      .update(runExecutionBindings)
      .set({
        processPid: meta.pid,
        processGroupId: meta.processGroupId,
        processHistory: sql`${runExecutionBindings.processHistory} || ${JSON.stringify([meta])}::jsonb`,
      })
      .where(
        and(
          eq(runExecutionBindings.runId, runId),
          eq(runExecutionBindings.ownerId, ownerId),
          isNull(runExecutionBindings.releasedAt),
        ),
      );
  }

  async function releaseAfterExecution(input: {
    companyId: string;
    runId: string;
    adapterStarted: boolean;
    isProcessAlive: (pid: number) => boolean;
    isProcessGroupAlive: (pid: number) => boolean;
    hasActiveChild: boolean;
  }) {
    const lease = await getRunBinding(input.companyId, input.runId);
    if (!lease || lease.releasedAt || lease.ownerId !== ownerId) return false;
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId));
    if (!run || !TERMINAL.includes(run.status) || input.hasActiveChild)
      return false;
    // An attempted launch with missing durable process evidence is ambiguous.
    // Keep capacity reserved for explicit operator reconciliation.
    if (input.adapterStarted && lease.processHistory.length === 0) return false;
    // An adapter may retry after a native session error. Every observed process
    // group remains evidence even if a later attempt becomes the active child.
    if (
      lease.processHistory.some(
        (meta) =>
          !meta.pid ||
          !meta.processGroupId ||
          input.isProcessAlive(meta.pid) ||
          input.isProcessGroupAlive(meta.processGroupId),
      )
    )
      return false;
    const released = await db
      .update(runExecutionBindings)
      .set({
        releasedAt: new Date(),
        releaseReason: input.adapterStarted
          ? "execution_settled_process_tree_gone"
          : "setup_stopped_before_dispatch",
      })
      .where(
        and(
          eq(runExecutionBindings.runId, input.runId),
          eq(runExecutionBindings.ownerId, ownerId),
          isNull(runExecutionBindings.releasedAt),
        ),
      )
      .returning({ runId: runExecutionBindings.runId });
    return released.length === 1;
  }
  async function reconcile(input: {
    companyId: string;
    runId: string;
    checkpointRef: string;
    isProcessAlive: (pid: number) => boolean;
    isProcessGroupAlive: (pid: number) => boolean;
    activity: Omit<
      LogActivityInput,
      "companyId" | "action" | "entityType" | "entityId"
    >;
  }) {
    return db.transaction(async (tx) => {
      const [lease] = await tx
        .select()
        .from(runExecutionBindings)
        .where(
          and(
            eq(runExecutionBindings.companyId, input.companyId),
            eq(runExecutionBindings.runId, input.runId),
          ),
        )
        .for("update");
      if (!lease) throw notFound("Run execution binding not found");
      if (lease.releasedAt)
        return { released: false, reason: "already_released" };
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.id, input.runId),
          ),
        )
        .for("update");
      const controllerPid = Number(lease.ownerId.split(":")[0]);
      // A live controller may still be unwinding or starting a child after a
      // concurrent cancellation. Only its own teardown may release capacity.
      if (
        !Number.isInteger(controllerPid) ||
        controllerPid <= 0 ||
        input.isProcessAlive(controllerPid)
      )
        throw conflict(
          "The original controller may still be active; its teardown retains account ownership",
        );
      if (!run || !TERMINAL.includes(run.status))
        throw conflict("Run must be terminal before reconciliation");
      if (
        lease.processHistory.length === 0 ||
        lease.processHistory.some((meta) => !meta.pid || !meta.processGroupId)
      )
        throw conflict(
          "Durable process evidence is missing; reservation cannot be automatically reconciled",
        );
      if (
        lease.processHistory.some(
          (meta) =>
            input.isProcessAlive(meta.pid) ||
            input.isProcessGroupAlive(meta.processGroupId!),
        )
      )
        throw conflict("The original process tree may still be alive");
      await tx
        .update(runExecutionBindings)
        .set({
          releasedAt: new Date(),
          releaseReason: `board_reconciled:${input.checkpointRef}`,
        })
        .where(eq(runExecutionBindings.runId, input.runId));
      await persistActivity(tx as unknown as Db, {
        ...input.activity,
        companyId: input.companyId,
        action: "execution_binding.reconciled",
        entityType: "heartbeat_run",
        entityId: input.runId,
        details: {
          checkpointRef: input.checkpointRef,
          bindingId: lease.bindingId,
          processTreeGone: true,
          controllerGone: true,
        },
      });
      return { released: true, reason: "process_tree_and_controller_gone" };
    });
  }
  async function assertBeforeLaunch(run: Run, agent: Agent, snapshot: ExecutionBindingSnapshot, runtimeConfig?: Record<string, unknown>, authorityTransaction?: Db) {
    const issueId = object(run.contextSnapshot).issueId;
    if (typeof issueId !== "string") return;
    const check = async (tx: Db) => {
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, run.companyId),
      )).for("update");
      const contract = await loadLatestIntelligentRoutingContract(tx as unknown as Db, run.companyId, issueId);
      if (!contract && !snapshot.routingReceipt) return;
      if (!contract || !snapshot.routingReceipt || !issue) {
        deny("intelligent_routing_contract_changed", "The routing contract changed after account reservation");
      }
      const [currentAgent] = await tx.select().from(agents).where(and(
        eq(agents.id, agent.id), eq(agents.companyId, run.companyId),
      ));
      const [row] = await tx.select().from(executionBindings).where(and(
        eq(executionBindings.id, snapshot.binding.id), eq(executionBindings.companyId, run.companyId),
      ));
      if (!currentAgent || !row || intelligentRoutingDigest({ config: currentAgent.adapterConfig, permissions: currentAgent.permissions }) !==
        snapshot.routingAuthorityDigest) {
        deny("intelligent_routing_role_changed", "Role configuration changed before native dispatch");
      }
      const currentSnapshot = resolveExecutionBindingSnapshot({
        binding: bindingView(row), selection: snapshot.selection, agent: currentAgent, taskKey: issueId,
        deliveryMode: "static_native",
      });
      if (intelligentRoutingDigest(currentSnapshot.adapterConfig) !== intelligentRoutingDigest(snapshot.adapterConfig)) {
        deny("intelligent_routing_configuration_changed", "The qualified execution configuration changed");
      }
      if (runtimeConfig && ROLE_CONFIG_KEYS.some((key) =>
        intelligentRoutingDigest(runtimeConfig[key] ?? null) !== intelligentRoutingDigest(snapshot.adapterConfig[key] ?? null))) {
        deny("intelligent_routing_configuration_changed", "Runtime instructions, workspace or tool permissions changed from the qualified configuration");
      }
      const receipt = assertIntelligentRoutingContract({
        contract, issue, agent: currentAgent, binding: bindingView(row), snapshot: currentSnapshot, now: new Date(),
        documentRevisionDigests: await loadRoutingDocumentRevisionDigests(tx as unknown as Db, run.companyId, issueId),
        runtimeFingerprint: await runtimeFingerprint({ adapterConfig: currentSnapshot.adapterConfig, binding: currentSnapshot.binding, runtimeFilePaths: currentSnapshot.binding.runtimeFilePaths }),
      });
      if (intelligentRoutingDigest(receipt) !== intelligentRoutingDigest(snapshot.routingReceipt)) {
        deny("intelligent_routing_contract_changed", "The routing decision changed after account reservation");
      }
    };
    if (authorityTransaction) await check(authorityTransaction);
    else await db.transaction(async (tx) => check(tx as unknown as Db));
  }
  return {
    list,
    create,
    disable,
    acquire,
    assertBeforeLaunch,
    getRunBinding,
    recordProcess,
    releaseAfterExecution,
    reconcile,
  };
}

// Callers hold the matching heartbeat-run rows FOR UPDATE, preventing a new
// acquisition while destructive company/agent cleanup is in progress.
export async function removeReleasedRunExecutionBindings(
  db: Db,
  companyId: string,
  runIds: string[],
) {
  if (runIds.length === 0) return;
  const scope = and(
    eq(runExecutionBindings.companyId, companyId),
    inArray(runExecutionBindings.runId, runIds),
  );
  const held = await db
    .select({ runId: runExecutionBindings.runId })
    .from(runExecutionBindings)
    .where(and(scope, isNull(runExecutionBindings.releasedAt)))
    .limit(1);
  if (held.length)
    throw conflict(
      "Account execution still requires reconciliation before deletion",
    );
  await db.delete(runExecutionBindings).where(scope);
}

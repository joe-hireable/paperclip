import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agents,
  documents,
  executionBindings,
  executionWorkspaces,
  issueComments,
  issueDocuments,
  issues,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import { intelligentRoutingContracts } from "@paperclipai/db/schema/intelligent_routing";
import {
  executionBindingSelectionSchema,
  type ExecutionBinding,
  type ExecutionBindingSelection,
  type ExecutionBindingSnapshot,
} from "@paperclipai/shared/execution-bindings";
import {
  intelligentExecutionProfileSchema,
  intelligentRoutingBaselineSchema,
  intelligentRoutingDecisionSchema,
  intelligentRoutingEvaluationSchema,
  intelligentRoutingObservationSchema,
  intelligentRoutingRequirementsSchema,
} from "@paperclipai/shared/intelligent-routing";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import {
  intelligentRoutingDigest,
  selectIntelligentExecutionBinding,
} from "./intelligent-routing-policy.js";
import { collectIntelligentRoutingRuntimeFingerprint } from "./intelligent-routing-runtime.js";

type Issue = typeof issues.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Reader = Pick<Db, "select">;
export type IntelligentRoutingContract =
  typeof intelligentRoutingContracts.$inferSelect;
export interface RoutingDocumentRevisionDigest {
  kind?: "document";
  key: string;
  documentId: string;
  revisionId: string | null;
  digest: string;
}
export type RoutingTaskInputDigest =
  | RoutingDocumentRevisionDigest
  | {
      kind: "comment";
      commentId: string;
      bodyDigest: string;
      authorAgentId: string | null;
      authorUserId: string | null;
      sourceTrustDigest: string;
      digest: string;
    }
  | {
      kind: "project_workspace" | "execution_workspace";
      workspaceId: string;
      cwdDigest: string | null;
      digest: string;
    };
export interface IntelligentRoutingContractReceipt {
  contractId: string;
  revision: number;
  inputDigest: string;
  requirementsDigest: string;
  profileDigest: string;
}
export interface IntelligentRoutingContractOptions {
  runtimeFingerprint?(input: {
    binding: ExecutionBinding;
    adapterConfig: Record<string, unknown>;
  }): Promise<string>;
  resolveSnapshot(input: {
    deliveryMode?: "static_native";
    binding: ExecutionBinding;
    selection: ExecutionBindingSelection;
    agent: Agent;
    taskKey: string;
    now: Date;
  }): ExecutionBindingSnapshot;
  now?: () => Date;
}

export const intelligentRoutingCandidateInputSchema = z
  .object({
    profile: intelligentExecutionProfileSchema,
    advertisedCapabilities: z.array(z.string().trim().min(1).max(200)).max(100),
    evaluations: z.array(intelligentRoutingEvaluationSchema).max(1),
    observation: intelligentRoutingObservationSchema,
    baseline: intelligentRoutingBaselineSchema.nullable(),
  })
  .strict();
export const intelligentRoutingContractInputSchema = z
  .object({
    expectedInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: z.number().int().nonnegative(),
    requirements: intelligentRoutingRequirementsSchema,
    candidates: z.array(intelligentRoutingCandidateInputSchema).min(1).max(32),
  })
  .strict()
  .superRefine((input, ctx) => {
    const cases = input.candidates.reduce(
      (count, item) =>
        count +
        item.evaluations.reduce(
          (sum, evaluation) => sum + evaluation.cases.length,
          0,
        ),
      0,
    );
    if (cases > 4096)
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Routing contracts permit at most 4096 case results",
      });
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 1_048_576)
      ctx.addIssue({
        code: "custom",
        message: "Routing contracts are limited to 1 MiB of metadata",
      });
  });
export type IntelligentRoutingContractInput = z.infer<
  typeof intelligentRoutingContractInputSchema
>;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function routingIssueInputDigest(
  issue: Partial<Issue>,
  documentRevisionDigests: readonly RoutingTaskInputDigest[],
): string {
  // The engine materialises executionWorkspaceId after selection. Pin the
  // requested workspace policy instead; launch separately checks effective cwd.
  const keys = [
    "title",
    "description",
    "projectId",
    "projectWorkspaceId",
    "goalId",
    "parentId",
    "reviewPolicy",
    "executionPolicy",
    "executionWorkspacePreference",
    "executionWorkspaceSettings",
    "sourceTrust",
    "workMode",
    "harnessKind",
  ] as const;
  const overrides = { ...object(issue.assigneeAdapterOverrides) };
  delete overrides.executionBinding;
  delete overrides.adapterConfig;
  return intelligentRoutingDigest({
    version: 1,
    input: Object.fromEntries(keys.map((key) => [key, issue[key] ?? null])),
    overrides,
    taskInputs: [...documentRevisionDigests].sort((a, b) => {
      const key = (item: RoutingTaskInputDigest) =>
        "commentId" in item
          ? `comment:${item.commentId}`
          : "workspaceId" in item
            ? `${item.kind}:${item.workspaceId}`
            : `document:${item.key}:${item.documentId}`;
      const aKey = key(a);
      const bKey = key(b);
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    }),
  });
}

export function routingConfigurationDigest(
  adapterConfig: Record<string, unknown>,
  permissions: Record<string, unknown>,
  runtimeFingerprint: string | null = null,
): string {
  return intelligentRoutingDigest({
    version: 1,
    adapterConfig,
    permissions,
    runtimeFingerprint,
  });
}

function assertFixedWorkingDirectory(
  adapterConfig: Record<string, unknown>,
  taskInputs: readonly RoutingTaskInputDigest[],
) {
  const cwd = adapterConfig.cwd;
  const workspace = taskInputs.find(
    (item) => item.kind === "execution_workspace",
  );
  if (
    typeof cwd !== "string" ||
    !(cwd.startsWith("/") || /^[A-Za-z]:[/\\]/.test(cwd)) ||
    (workspace?.kind === "execution_workspace" &&
      workspace.cwdDigest !== intelligentRoutingDigest(cwd))
  )
    deny(
      "routing_contract_configuration_changed",
      "Routing requires an explicit qualified working directory matching the realised execution workspace",
    );
}

export async function loadRoutingTaskInputDigests(
  db: Reader,
  companyId: string,
  issueId: string,
): Promise<RoutingTaskInputDigest[]> {
  const [issue] = await db
    .select({
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspacePreference: issues.executionWorkspacePreference,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!issue) throw notFound("Issue not found");
  const workspaceInputs: RoutingTaskInputDigest[] = [];
  const settings = object(issue.executionWorkspaceSettings);
  if (issue.projectId) {
    if (
      !issue.projectWorkspaceId ||
      !issue.executionWorkspaceId ||
      issue.executionWorkspacePreference !== "reuse_existing"
    )
      throw unprocessable(
        "Project routing requires explicit project and existing execution workspaces with reuse_existing preference",
      );
    const [projectWorkspace] = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, companyId),
          eq(projectWorkspaces.projectId, issue.projectId),
          eq(projectWorkspaces.id, issue.projectWorkspaceId),
        ),
      );
    const [executionWorkspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.projectId, issue.projectId),
          eq(executionWorkspaces.id, issue.executionWorkspaceId),
        ),
      );
    if (
      !projectWorkspace ||
      !executionWorkspace ||
      executionWorkspace.projectWorkspaceId !== projectWorkspace.id
    )
      throw unprocessable(
        "Routing workspaces must belong to the task's company and project",
      );
    if (
      executionWorkspace.status !== "active" ||
      executionWorkspace.providerType !== "local_fs" ||
      !executionWorkspace.cwd ||
      !["shared_workspace", "isolated_workspace", "operator_branch"].includes(
        executionWorkspace.mode,
      ) ||
      settings.mode !== executionWorkspace.mode ||
      ["workspaceStrategy", "workspaceRuntime", "environmentId"].some(
        (key) => settings[key] != null,
      )
    )
      throw unprocessable(
        "Routing requires a realised active local workspace and matching reuse settings without dynamic workspace overrides",
      );
    const projectKeys = [
      "id",
      "companyId",
      "projectId",
      "sourceType",
      "cwd",
      "repoUrl",
      "repoRef",
      "defaultRef",
      "visibility",
      "setupCommand",
      "cleanupCommand",
      "remoteProvider",
      "remoteWorkspaceRef",
      "sharedWorkspaceKey",
      "metadata",
    ] as const;
    const executionKeys = [
      "id",
      "companyId",
      "projectId",
      "projectWorkspaceId",
      "sourceIssueId",
      "mode",
      "strategyType",
      "status",
      "cwd",
      "repoUrl",
      "baseRef",
      "branchName",
      "providerType",
      "providerRef",
      "derivedFromExecutionWorkspaceId",
      "metadata",
    ] as const;
    const projectConfig = Object.fromEntries(
      projectKeys.map((key) => [key, projectWorkspace[key]]),
    );
    const executionConfig = Object.fromEntries(
      executionKeys.map((key) => [key, executionWorkspace[key]]),
    );
    if (
      Buffer.byteLength(
        JSON.stringify({ projectConfig, executionConfig }),
        "utf8",
      ) > 1_048_576
    )
      throw unprocessable("Routing workspace metadata exceeds 1 MiB");
    workspaceInputs.push(
      {
        kind: "project_workspace",
        workspaceId: projectWorkspace.id,
        cwdDigest: projectWorkspace.cwd
          ? intelligentRoutingDigest(projectWorkspace.cwd)
          : null,
        digest: intelligentRoutingDigest(projectConfig),
      },
      {
        kind: "execution_workspace",
        workspaceId: executionWorkspace.id,
        cwdDigest: intelligentRoutingDigest(executionWorkspace.cwd),
        digest: intelligentRoutingDigest(executionConfig),
      },
    );
  } else if (
    issue.projectWorkspaceId ||
    issue.executionWorkspaceId ||
    (issue.executionWorkspacePreference != null &&
      !["inherit", "agent_default"].includes(
        issue.executionWorkspacePreference,
      )) ||
    (settings.mode != null &&
      !["inherit", "agent_default"].includes(String(settings.mode))) ||
    ["workspaceStrategy", "workspaceRuntime", "environmentId"].some(
      (key) => settings[key] != null,
    )
  ) {
    throw unprocessable(
      "Tasks without a project require a fixed role working directory without dynamic workspace settings",
    );
  }
  const rows = await db
    .select({
      key: issueDocuments.key,
      documentId: documents.id,
      revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber,
      title: documents.title,
      format: documents.format,
      body: sql<
        string | null
      >`case when octet_length(${documents.latestBody}) <= 1048576 then ${documents.latestBody} else null end`,
      sourceTrust: documents.sourceTrust,
    })
    .from(issueDocuments)
    .innerJoin(
      documents,
      and(
        eq(issueDocuments.documentId, documents.id),
        eq(documents.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, issueId),
      ),
    )
    .limit(101);
  const comments = await db
    .select({
      commentId: issueComments.id,
      body: sql<
        string | null
      >`case when octet_length(${issueComments.body}) <= 1048576 then ${issueComments.body} else null end`,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      authorType: issueComments.authorType,
      onBehalfOfUserId: issueComments.onBehalfOfUserId,
      sourceTrust: issueComments.sourceTrust,
      presentation: issueComments.presentation,
      metadata: issueComments.metadata,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
      ),
    )
    .limit(101);
  if (
    rows.length > 100 ||
    comments.length > 100 ||
    rows.some((row) => row.body === null) ||
    comments.some((row) => row.body === null) ||
    Buffer.byteLength(JSON.stringify({ documents: rows, comments }), "utf8") >
      8_388_608
  )
    throw unprocessable(
      "Routing input exceeds the limit of 100 documents, 100 comments, 1 MiB per body or 8 MiB total",
    );
  return [
    ...workspaceInputs,
    ...rows.map(({ key, documentId, revisionId, ...content }) => ({
      kind: "document" as const,
      key,
      documentId,
      revisionId,
      digest: intelligentRoutingDigest(content),
    })),
    ...comments.map(({ commentId, ...content }) => ({
      kind: "comment" as const,
      commentId,
      bodyDigest: intelligentRoutingDigest(content.body),
      authorAgentId: content.authorAgentId,
      authorUserId: content.authorUserId,
      sourceTrustDigest: intelligentRoutingDigest(content.sourceTrust),
      digest: intelligentRoutingDigest(content),
    })),
  ];
}

// Compatibility name for existing execution hooks; the result now pins every
// relevant task input, including human and agent comments, not just documents.
export const loadRoutingDocumentRevisionDigests = loadRoutingTaskInputDigests;

export async function loadLatestIntelligentRoutingContract(
  db: Reader,
  companyId: string,
  issueId: string,
): Promise<IntelligentRoutingContract | null> {
  const rows = await db
    .select()
    .from(intelligentRoutingContracts)
    .where(
      and(
        eq(intelligentRoutingContracts.companyId, companyId),
        eq(intelligentRoutingContracts.issueId, issueId),
      ),
    )
    .orderBy(desc(intelligentRoutingContracts.revision))
    .limit(1);
  return rows[0] ?? null;
}

export class IntelligentRoutingContractError extends HttpError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(409, message, { code });
  }
}
function deny(code: string, message: string): never {
  throw new IntelligentRoutingContractError(code, message);
}

// Call with the latest row while holding the issue lock, then repeat immediately
// before launch with current document digests, permissions and effective config.
export function assertIntelligentRoutingContract(input: {
  contract: IntelligentRoutingContract;
  issue: Issue;
  agent: Agent;
  binding: ExecutionBinding;
  snapshot: ExecutionBindingSnapshot;
  documentRevisionDigests: readonly RoutingTaskInputDigest[];
  runtimeFingerprint?: string | null;
  now: Date;
}): IntelligentRoutingContractReceipt {
  const {
    contract,
    issue,
    agent,
    binding,
    snapshot,
    documentRevisionDigests,
    now,
  } = input;
  if (
    contract.companyId !== issue.companyId ||
    contract.issueId !== issue.id ||
    agent.companyId !== issue.companyId ||
    binding.companyId !== issue.companyId ||
    contract.assigneeAgentId !== agent.id ||
    issue.assigneeAgentId !== agent.id
  )
    deny(
      "routing_contract_scope",
      "Routing authority no longer matches this company, task and assignee",
    );
  if (
    routingIssueInputDigest(issue, documentRevisionDigests) !==
    contract.inputDigest
  )
    deny(
      "routing_contract_input_changed",
      "Task inputs, linked documents or comments changed after routing approval",
    );
  const original = intelligentRoutingDecisionSchema.safeParse(
    contract.decision,
  );
  if (!original.success || original.data.status !== "selected")
    deny(
      "routing_contract_no_selection",
      "This routing revision does not authorise execution",
    );
  const decision = original.data;
  const applied = executionBindingSelectionSchema.safeParse(
    object(issue.assigneeAdapterOverrides).executionBinding,
  );
  if (
    !applied.success ||
    intelligentRoutingDigest(applied.data) !==
      intelligentRoutingDigest(decision.selection) ||
    intelligentRoutingDigest(snapshot.selection) !==
      intelligentRoutingDigest(decision.selection) ||
    binding.id !== decision.selection.bindingId ||
    snapshot.binding.id !== binding.id
  )
    deny(
      "routing_contract_selection_changed",
      "The task's execution binding changed or was removed after routing approval",
    );
  assertFixedWorkingDirectory(snapshot.adapterConfig, documentRevisionDigests);
  if (
    routingConfigurationDigest(
      snapshot.adapterConfig,
      agent.permissions,
      input.runtimeFingerprint ?? null,
    ) !== decision.profile.configurationDigest
  )
    deny(
      "routing_contract_configuration_changed",
      "Effective harness configuration or role permissions changed after qualification",
    );
  const metadata = z
    .array(intelligentRoutingCandidateInputSchema)
    .safeParse(contract.candidateEvidenceSnapshot);
  if (!metadata.success)
    deny(
      "routing_contract_evidence_invalid",
      "Stored routing evidence is invalid",
    );
  const matching = metadata.data.filter(
    (item) => item.profile.bindingId === binding.id,
  );
  if (
    matching.length !== 1 ||
    intelligentRoutingDigest(matching[0]!.profile) !== decision.profileDigest
  )
    deny(
      "routing_contract_profile_changed",
      "Stored exact execution profile no longer matches the routing decision",
    );
  const replay = selectIntelligentExecutionBinding({
    companyId: issue.companyId,
    agentId: agent.id,
    requirements: contract.requirements,
    candidates: [{ ...matching[0]!, binding }],
    now,
  });
  if (
    replay.status !== "selected" ||
    replay.profileDigest !== decision.profileDigest ||
    replay.requirementsDigest !== decision.requirementsDigest ||
    replay.mode !== decision.mode
  )
    deny(
      "routing_contract_qualification_expired",
      "Selected route no longer satisfies the approved quality, availability and billing requirements",
    );
  return {
    contractId: contract.id,
    revision: contract.revision,
    inputDigest: contract.inputDigest,
    requirementsDigest: replay.requirementsDigest!,
    profileDigest: replay.profileDigest,
  };
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
function provisionalSelection(
  binding: ExecutionBinding,
): ExecutionBindingSelection {
  return {
    bindingId: binding.id,
    model: binding.models[0]!,
    requiredCapabilities: binding.capabilities,
    dataClass: binding.dataClasses[0]!,
    reason: "Resolve the immutable routing profile without dispatch",
    evidenceRefs: binding.evidenceRefs,
  };
}

export function intelligentRoutingContractService(
  db: Db,
  options: IntelligentRoutingContractOptions,
) {
  const now = options.now ?? (() => new Date());
  const runtimeFingerprint = options.runtimeFingerprint ?? ((input: { binding: ExecutionBinding; adapterConfig: Record<string, unknown> }) => collectIntelligentRoutingRuntimeFingerprint({ ...input, runtimeFilePaths: input.binding.runtimeFilePaths }));
  async function loadIssue(
    reader: Reader,
    companyId: string,
    issueId: string,
    lock = false,
  ) {
    const query = reader
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    const rows = lock ? await query.for("update") : await query;
    if (!rows[0]) throw notFound("Issue not found");
    return rows[0];
  }
  async function loadAgent(reader: Reader, issue: Issue) {
    if (!issue.assigneeAgentId)
      throw unprocessable(
        "Assign an agent before authorising intelligent routing",
      );
    const [agent] = await reader
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, issue.companyId),
          eq(agents.id, issue.assigneeAgentId),
        ),
      );
    if (!agent)
      throw unprocessable("The assigned agent is unavailable in this company");
    return agent;
  }
  async function prepare(
    reader: Reader,
    companyId: string,
    issueId: string,
    raw: unknown,
    lock: boolean,
  ) {
    const input = intelligentRoutingContractInputSchema.parse(raw);
    const issue = await loadIssue(reader, companyId, issueId, lock);
    const documentRevisionDigests = await loadRoutingDocumentRevisionDigests(
      reader,
      companyId,
      issueId,
    );
    const inputDigest = routingIssueInputDigest(issue, documentRevisionDigests);
    const latest = await loadLatestIntelligentRoutingContract(
      reader,
      companyId,
      issueId,
    );
    if (
      input.expectedInputDigest !== inputDigest ||
      input.expectedRevision !== (latest?.revision ?? 0)
    )
      throw conflict(
        "Task input or routing revision changed; refresh routing context before approving",
      );
    if (lock && (issue.executionRunId || issue.checkoutRunId))
      throw conflict(
        "Do not replace routing authority while this task has an active execution",
      );
    const agent = await loadAgent(reader, issue);
    const rows = await reader
      .select()
      .from(executionBindings)
      .where(eq(executionBindings.companyId, companyId));
    const inventory = new Map(rows.map((row) => [row.id, bindingView(row)]));
    const evaluatedAt = now();
    const candidates = await Promise.all(
      input.candidates.map(async (candidate) => {
        const binding = inventory.get(candidate.profile.bindingId);
        if (!binding)
          throw unprocessable(
            "Candidate binding is unavailable in this company",
          );
        // Preserve inspectable native exclusions without allowing an ineligible
        // binding to abort evaluation of other candidates in the inventory.
        if (
          !binding.enabled ||
          !binding.allowedAgentIds.includes(agent.id) ||
          Date.parse(binding.verifiedUntil) <= evaluatedAt.getTime() ||
          binding.reasoningEffort === undefined
        ) {
          return { ...candidate, binding };
        }
        const snapshot = options.resolveSnapshot({
          deliveryMode: "static_native",
          binding,
          selection: provisionalSelection(binding),
          agent,
          taskKey: issue.id,
          now: evaluatedAt,
        });
        assertFixedWorkingDirectory(
          snapshot.adapterConfig,
          documentRevisionDigests,
        );
        const fingerprint = await runtimeFingerprint({
          binding,
          adapterConfig: snapshot.adapterConfig,
        });
        if (
          routingConfigurationDigest(
            snapshot.adapterConfig,
            agent.permissions,
            fingerprint,
          ) !== candidate.profile.configurationDigest
        )
          throw conflict(
            "Candidate profile does not match the actual effective harness configuration",
          );
        return { ...candidate, binding };
      }),
    );
    const decision = selectIntelligentExecutionBinding({
      companyId,
      agentId: agent.id,
      requirements: input.requirements,
      candidates,
      now: evaluatedAt,
    });
    return {
      input,
      issue,
      agent,
      inputDigest,
      revision: (latest?.revision ?? 0) + 1,
      decision,
      evaluatedAt,
    };
  }
  return {
    async context(companyId: string, issueId: string) {
      const issue = await loadIssue(db, companyId, issueId);
      const agent = await loadAgent(db, issue);
      const documentRevisionDigests = await loadRoutingDocumentRevisionDigests(
        db,
        companyId,
        issueId,
      );
      const latest = await loadLatestIntelligentRoutingContract(
        db,
        companyId,
        issueId,
      );
      const bindings = await db
        .select()
        .from(executionBindings)
        .where(
          and(
            eq(executionBindings.companyId, companyId),
            eq(executionBindings.enabled, true),
          ),
        );
      const profiles = await Promise.all(
        bindings.map(async (row) => {
          const binding = bindingView(row);
          try {
            const snapshot = options.resolveSnapshot({
              deliveryMode: "static_native",
              binding,
              selection: provisionalSelection(binding),
              agent,
              taskKey: issue.id,
              now: now(),
            });
            assertFixedWorkingDirectory(
              snapshot.adapterConfig,
              documentRevisionDigests,
            );
            const fingerprint = await runtimeFingerprint({
              binding,
              adapterConfig: snapshot.adapterConfig,
            });
            return {
              bindingId: binding.id,
              accountKey: binding.accountKey,
            harness: binding.adapterType,
            deliveryMode: "static_native" as const,
              model: binding.models[0],
              effort: binding.reasoningEffort ?? null,
              configurationDigest: routingConfigurationDigest(
                snapshot.adapterConfig,
                agent.permissions,
                fingerprint,
              ),
              runtimeFingerprint: fingerprint,
              configurationResolved: true,
              effortPinned: binding.reasoningEffort !== undefined,
            };
          } catch {
            return {
              bindingId: binding.id,
              configurationResolved: false,
              effortPinned: binding.reasoningEffort !== undefined,
            };
          }
        }),
      );
      return {
        companyId,
        issueId,
        assigneeAgentId: agent.id,
        inputDigest: routingIssueInputDigest(issue, documentRevisionDigests),
        latestRevision: latest?.revision ?? 0,
        documentRevisionDigests,
        profiles,
      };
    },
    async latest(companyId: string, issueId: string) {
      await loadIssue(db, companyId, issueId);
      return loadLatestIntelligentRoutingContract(db, companyId, issueId);
    },
    async preview(companyId: string, issueId: string, input: unknown) {
      const prepared = await prepare(db, companyId, issueId, input, false);
      return {
        inputDigest: prepared.inputDigest,
        revision: prepared.revision,
        decision: prepared.decision,
      };
    },
    async create(
      companyId: string,
      issueId: string,
      raw: unknown,
      createdByUserId: string,
    ) {
      if (!createdByUserId.trim())
        throw unprocessable(
          "Routing contracts require an identified board author",
        );
      return db.transaction(async (tx) => {
        const prepared = await prepare(tx, companyId, issueId, raw, true);
        const {
          issue,
          input,
          decision,
          agent,
          inputDigest,
          revision,
          evaluatedAt,
        } = prepared;
        const [contract] = await tx
          .insert(intelligentRoutingContracts)
          .values({
            companyId,
            issueId,
            assigneeAgentId: agent.id,
            revision,
            inputDigest,
            requirements: input.requirements,
            candidateEvidenceSnapshot: input.candidates,
            decision,
            createdByUserId,
            createdAt: evaluatedAt,
          })
          .returning();
        if (!contract) throw new Error("Routing contract was not persisted");
        const overrides = { ...object(issue.assigneeAdapterOverrides) };
        if (decision.status === "selected")
          overrides.executionBinding = decision.selection;
        else delete overrides.executionBinding;
        await tx
          .update(issues)
          .set({
            assigneeAdapterOverrides: overrides,
            ...(decision.status === "no_selection"
              ? { status: "blocked" }
              : {}),
            updatedAt: evaluatedAt,
          })
          .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
        await persistActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: createdByUserId,
          action: "issue.routing_contract_created",
          entityType: "issue",
          entityId: issueId,
          issueId,
          details: {
            contractId: contract.id,
            revision,
            inputDigest,
            decisionStatus: decision.status,
            profileDigest:
              decision.status === "selected" ? decision.profileDigest : null,
          },
        });
        return contract;
      });
    },
  };
}

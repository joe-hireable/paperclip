import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  authUsers,
  documents,
  documentRevisions,
  issueDocuments,
  issueComments,
  projects,
  goals,
  projectGoals,
  type Db,
} from "@paperclipai/db";
import {
  issueDocumentKeySchema,
  sourceTrustMetadataSchema,
} from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import { conflict, forbidden } from "../errors.js";
import { issueService } from "./issues.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

export function canonicalProjectContext(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value))
    return `[${value.map(canonicalProjectContext).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalProjectContext(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalProjectContext(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const defaults = [
  "current-work",
  "operating-goal",
  "requirements-register",
  "plan",
];
export const projectCoordinatorContextSelectionSchema = z
  .object({
    documentKeys: z.array(issueDocumentKeySchema).max(8).optional(),
    commentIds: z.array(z.string().uuid()).max(32).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["documentKeys", "commentIds"] as const) {
      if (new Set(value[key]).size !== (value[key]?.length ?? 0))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Duplicate context selection",
        });
    }
    if (new Set([...defaults, ...(value.documentKeys ?? [])]).size > 8)
      ctx.addIssue({
        code: "custom",
        path: ["documentKeys"],
        message: "At most eight keys including canonical keys",
      });
  });
const attribution = {
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdByRunId: z.string().uuid().nullable(),
};
export const projectCoordinatorContextSchema = z
  .object({
    version: z.literal(1),
    companyId: z.string().uuid(),
    projectId: z.string().uuid(),
    masterIssueId: z.string().uuid(),
    selection: z
      .object({
        documentKeys: z.array(z.string()).max(8),
        commentIds: z.array(z.string().uuid()).max(32),
      })
      .strict(),
    project: z
      .object({ name: z.string(), description: z.string().nullable() })
      .strict(),
    goals: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string(),
            description: z.string().nullable(),
            status: z.string(),
            level: z.string(),
            updatedAt: z.string(),
            sourceDigest: digest,
          })
          .strict(),
      )
      .max(16),
    documents: z
      .array(
        z.discriminatedUnion("present", [
          z.object({ key: z.string(), present: z.literal(false) }).strict(),
          z
            .object({
              key: z.string(),
              present: z.literal(true),
              id: z.string().uuid(),
              revisionId: z.string().uuid(),
              revisionNumber: z.number().int(),
              body: z.string(),
              title: z.string().nullable(),
              sourceDigest: digest,
              sourceTrust: sourceTrustMetadataSchema.nullable(),
              ...attribution,
            })
            .strict(),
        ]),
      )
      .max(8),
    comments: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            body: z.string(),
            createdAt: z.string(),
            updatedAt: z.string(),
            sourceDigest: digest,
            sourceTrust: sourceTrustMetadataSchema.nullable(),
            authorType: z.string().nullable(),
            onBehalfOfUserId: z.string().nullable(),
            ...attribution,
          })
          .strict(),
      )
      .max(32),
    boardInstructionDigest: digest,
    digest,
  })
  .strict();
export type ProjectCoordinatorContext = z.infer<
  typeof projectCoordinatorContextSchema
>;
type ReadCeiling = (
  db: Db,
  actor: AuthorizationActor,
  companyId: string,
  projectId?: string,
  issueId?: string,
) => Promise<void>;
type Scope = {
  companyId: string;
  projectId: string;
  masterIssueId: string;
  sourceCommentId: string;
  responsibleUserId: string;
  executionAgentId: string;
  dataClass: string;
  runId?: string;
};

// Runs inside the caller's short ancestry-lock transaction. No network or extra API authority.
export async function captureProjectCoordinatorContext(
  db: Db,
  scope: Scope,
  raw: unknown,
  ceiling: ReadCeiling,
): Promise<ProjectCoordinatorContext> {
  if (scope.dataClass !== "private")
    throw forbidden(
      "Project history requires private-qualified coordination policy",
    );
  const input = projectCoordinatorContextSelectionSchema.parse(raw);
  const selection = {
    documentKeys: [
      ...new Set([...defaults, ...(input.documentKeys ?? [])]),
    ].sort(),
    commentIds: [...(input.commentIds ?? [])].sort(),
  };
  const responsible: AuthorizationActor = {
    type: "board",
    source: "session",
    userId: scope.responsibleUserId,
    ignoreInstanceAdmin: true,
  };
  const role: AuthorizationActor = {
    type: "agent",
    source: "agent_jwt",
    agentId: scope.executionAgentId,
    companyId: scope.companyId,
    onBehalfOfUserId: scope.responsibleUserId,
    keyScope: { kind: "standard" },
    ...(scope.runId ? { runId: scope.runId } : {}),
  };
  for (const actor of [responsible, role]) {
    await ceiling(db, actor, scope.companyId);
    await ceiling(db, actor, scope.companyId, scope.projectId);
    await ceiling(
      db,
      actor,
      scope.companyId,
      scope.projectId,
      scope.masterIssueId,
    );
  }
  const [project] = await db
    .select({ name: projects.name, description: projects.description })
    .from(projects)
    .where(
      and(
        eq(projects.id, scope.projectId),
        eq(projects.companyId, scope.companyId),
      ),
    );
  if (!project) throw conflict("Project context unavailable");
  const linked = await db
    .select({ goal: goals })
    .from(projectGoals)
    .innerJoin(goals, eq(goals.id, projectGoals.goalId))
    .where(
      and(
        eq(projectGoals.projectId, scope.projectId),
        eq(projectGoals.companyId, scope.companyId),
        eq(goals.companyId, scope.companyId),
      ),
    )
    .orderBy(asc(goals.id))
    .limit(17)
    .for("share");
  if (linked.length > 16)
    throw conflict("Project context exceeds linked goal limit");
  const goalRows = linked.map(({ goal }) => ({
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    level: goal.level,
    updatedAt: goal.updatedAt.toISOString(),
    sourceDigest: hash(goal),
  }));
  const runIds = new Set<string>();
  const docRows: ProjectCoordinatorContext["documents"] = [];
  for (const key of selection.documentKeys) {
    const [row] = await db
      .select({ document: documents, revision: documentRevisions })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .innerJoin(
        documentRevisions,
        eq(documentRevisions.id, documents.latestRevisionId),
      )
      .where(
        and(
          eq(issueDocuments.issueId, scope.masterIssueId),
          eq(issueDocuments.key, key),
          eq(documents.companyId, scope.companyId),
          eq(documentRevisions.companyId, scope.companyId),
        ),
      )
      .for("share");
    if (!row) {
      docRows.push({ key, present: false });
      continue;
    }
    const { document: d, revision: r } = row;
    if (
      r.documentId !== d.id ||
      r.body !== d.latestBody ||
      r.revisionNumber !== d.latestRevisionNumber
    )
      throw conflict("Project context document head changed");
    if (r.createdByRunId) runIds.add(r.createdByRunId);
    docRows.push({
      key,
      present: true,
      id: d.id,
      revisionId: r.id,
      revisionNumber: r.revisionNumber,
      body: r.body,
      title: r.title,
      sourceDigest: hash({ revision: r, sourceTrust: d.sourceTrust }),
      sourceTrust: d.sourceTrust,
      createdByAgentId: r.createdByAgentId,
      createdByUserId: r.createdByUserId,
      createdByRunId: r.createdByRunId,
    });
  }
  const [source] = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, scope.sourceCommentId),
        eq(issueComments.issueId, scope.masterIssueId),
        eq(issueComments.companyId, scope.companyId),
      ),
    );
  if (!source) throw conflict("Project context intake comment missing");
  const comments = selection.commentIds.length
    ? await db
        .select()
        .from(issueComments)
        .where(
          and(
            inArray(issueComments.id, selection.commentIds),
            eq(issueComments.companyId, scope.companyId),
            eq(issueComments.issueId, scope.masterIssueId),
            isNull(issueComments.deletedAt),
          ),
        )
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
        .for("share")
    : [];
  if (comments.length !== selection.commentIds.length)
    throw conflict("Selected project context comment unavailable");
  for (const c of comments) {
    if (
      c.createdAt > source.createdAt ||
      (c.createdAt.getTime() === source.createdAt.getTime() &&
        c.id >= source.id)
    )
      throw conflict("Project context selection requires preceding comments");
    // Synthetic/system presentation and unattributed legacy sentinels are not raw history.
    if (
      c.authorType === "system" ||
      c.presentation ||
      c.derivedAuthorAgentId ||
      (!c.authorAgentId && !c.authorUserId)
    )
      throw conflict(
        "Selected project comment requires native direct attribution",
      );
    if (c.createdByRunId) runIds.add(c.createdByRunId);
  }
  const commentRows: ProjectCoordinatorContext["comments"] = [];
  for (const c of comments) {
    if (!c.authorAgentId) {
      const [user] = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, c.authorUserId!));
      if (!user || user.id === "local-board")
        throw conflict(
          "Project comment author requires direct native attribution",
        );
    }
    // Direct native authors avoid lazy legacy reattribution writes; reuse the same text projection as GET.
    const projected = await issueService(db).getComment(c.id);
    if (!projected || projected.deletedAt || projected.derivedAuthorAgentId)
      throw conflict("Project comment changed during projection");
    commentRows.push({
      id: c.id,
      body: projected.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      sourceDigest: hash(c),
      sourceTrust: c.sourceTrust,
      authorType: c.authorType,
      onBehalfOfUserId: c.onBehalfOfUserId,
      createdByAgentId: c.authorAgentId,
      createdByUserId: c.authorUserId,
      createdByRunId: c.createdByRunId,
    });
  }
  // Include edits/deletions of older, unselected board comments, not only new IDs.
  // Native system notices and agent progress cannot self-invalidate settlement.
  const board = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, scope.companyId),
        eq(issueComments.issueId, scope.masterIssueId),
        isNull(issueComments.authorAgentId),
        or(
          isNull(issueComments.authorType),
          ne(issueComments.authorType, "system"),
        ),
      ),
    )
    .orderBy(asc(issueComments.id))
    .limit(1025)
    .for("share");
  if (board.length > 1024)
    throw conflict("Project context exceeds board history bound");
  const rawSnapshot = {
    version: 1 as const,
    companyId: scope.companyId,
    projectId: scope.projectId,
    masterIssueId: scope.masterIssueId,
    selection,
    project,
    goals: goalRows,
    documents: docRows,
    comments: commentRows,
    boardInstructionDigest: hash(board),
  };
  if (Buffer.byteLength(canonicalProjectContext(rawSnapshot)) > 65536)
    throw conflict("Project context exceeds 64 KiB");
  const redactions = createRunSecretRedactionRegistry(db);
  let snapshot = await redactions.redactForIssue(
    scope.companyId,
    scope.masterIssueId,
    rawSnapshot,
  );
  for (const runId of [...runIds].sort())
    snapshot = await redactions.redactForRun(scope.companyId, runId, snapshot);
  const result = projectCoordinatorContextSchema.parse({
    ...snapshot,
    digest: hash(snapshot),
  });
  if (Buffer.byteLength(canonicalProjectContext(result)) > 65536)
    throw conflict("Project context exceeds 64 KiB");
  return result;
}

export async function assertProjectCoordinatorContext(
  db: Db,
  scope: Scope,
  snapshot: ProjectCoordinatorContext | undefined,
  ceiling: ReadCeiling,
) {
  if (!snapshot) return;
  const { digest: expected, ...body } = snapshot;
  if (
    hash(body) !== expected ||
    snapshot.companyId !== scope.companyId ||
    snapshot.projectId !== scope.projectId ||
    snapshot.masterIssueId !== scope.masterIssueId
  )
    throw conflict("Project context receipt changed");
  const current = await captureProjectCoordinatorContext(
    db,
    scope,
    snapshot.selection,
    ceiling,
  );
  if (current.digest !== snapshot.digest)
    throw conflict("Project context is stale; prepare a new attempt");
}

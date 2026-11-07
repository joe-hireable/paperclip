/** Project conversation issues are context-only: they must never start a heartbeat run. */
import { and, asc, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { assertCoordinatorRunAdmission } from "../project-coordinator-attempts.js";

export const PROJECT_MASTER_CONTEXT_ONLY_ERROR = "project_master_context_only";

const PROJECT_CONVERSATION_CONTEXT_ONLY_ORIGIN_KINDS = new Set([
  "project_master_chat",
  "project_coordinator_intake",
  "project_coordinator_attempt",
]);

export const COORDINATOR_ATTEMPT_ORIGIN_KIND = "project_coordinator_attempt";

export function isProjectConversationContextOnlyOrigin(
  originKind: string | null | undefined,
): boolean {
  return originKind != null && PROJECT_CONVERSATION_CONTEXT_ONLY_ORIGIN_KINDS.has(originKind);
}

export const PROJECT_MASTER_CONTEXT_ONLY_MESSAGE =
  "Project conversation context is not an executable assignment.";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Serializes behind adoption's issue row lock, then treats master/intake as
 * context-only. A coordinator attempt is executable only when admission
 * succeeds for this exact run.
 */
export async function isProjectConversationRun(
  db: Db,
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "id" | "agentId" | "companyId" | "nativeIssueId" | "contextSnapshot"
  >,
  reader?: Db,
  allowCoordinator = true,
): Promise<boolean> {
  const ids = [
    ...new Set(
      [
        run.nativeIssueId,
        readNonEmptyString(parseObject(run.contextSnapshot).issueId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return false;
  const check = async (tx: Db) => {
    // Adoption holds this same row lock through its pending-work check and commit.
    // Once this check passes, the queued/running run prevents ordinary adoption.
    const identity = await tx
      .select({ id: issues.id, originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), inArray(issues.id, ids)));
    if (identity.some((row) => row.originKind === COORDINATOR_ATTEMPT_ORIGIN_KIND)) {
      if (!allowCoordinator) return true;
      if (
        ids.length !== 1 ||
        identity.length !== 1 ||
        run.nativeIssueId !== ids[0]
      )
        return true;
      try {
        await assertCoordinatorRunAdmission(tx, {
          companyId: run.companyId,
          attemptId: ids[0]!,
          agentId: run.agentId,
          runId: run.id,
        });
        return false;
      } catch {
        return true;
      }
    }
    const rows = await tx
      .select({ originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), inArray(issues.id, ids)))
      .orderBy(asc(issues.id))
      .for("update");
    return rows.some((row) =>
      isProjectConversationContextOnlyOrigin(row.originKind),
    );
  };
  return reader ? check(reader) : db.transaction((tx) => check(tx as unknown as Db));
}

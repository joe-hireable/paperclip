/** Project conversation issues are context-only: they must never start a heartbeat run. */
export const PROJECT_MASTER_CONTEXT_ONLY_ERROR = "project_master_context_only";

const PROJECT_CONVERSATION_CONTEXT_ONLY_ORIGIN_KINDS = new Set([
  "project_master_chat",
  "project_coordinator_intake",
  "project_coordinator_attempt",
]);

export function isProjectConversationContextOnlyOrigin(
  originKind: string | null | undefined,
): boolean {
  return originKind != null && PROJECT_CONVERSATION_CONTEXT_ONLY_ORIGIN_KINDS.has(originKind);
}

export const PROJECT_MASTER_CONTEXT_ONLY_MESSAGE =
  "Project conversation context is not an executable assignment.";

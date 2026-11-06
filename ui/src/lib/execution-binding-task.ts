import type { ExecutionBindingSelection } from "@paperclipai/shared/execution-bindings";
import { executionBindingsApi } from "../api/execution-bindings";

interface BindingTask {
  companyId: string;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  title?: string;
  description?: string | null;
  assigneeAdapterOverrides?: {
    executionBinding?: ExecutionBindingSelection;
    adapterConfig?: Record<string, unknown>;
    useProjectWorkspace?: boolean;
  } | null;
}
interface BindingAgent {
  id: string;
  status: string;
  runtimeConfig: Record<string, unknown>;
}
export function requiresTaskBinding(agent: BindingAgent | null | undefined) {
  return agent?.runtimeConfig?.executionBindingRequired === true;
}
export function boundTaskOverrides(selection: ExecutionBindingSelection) {
  return { executionBinding: selection, useProjectWorkspace: true };
}
export function bindingInvalidationPatch(issue: BindingTask, patch: Record<string, unknown>) {
  if (!issue.assigneeAdapterOverrides?.executionBinding) return patch;
  const changesInputs = ["assigneeAgentId", "projectId", "projectWorkspaceId", "title", "description", "executionWorkspaceId", "executionWorkspaceSettings"].some(
    key => Object.hasOwn(patch, key) && patch[key] !== (issue as unknown as Record<string, unknown>)[key],
  );
  return changesInputs ? { ...patch, assigneeAdapterOverrides: null, status: "backlog" } : patch;
}
export async function requalifyTaskBinding(
  issue: BindingTask,
  agent: BindingAgent | null | undefined,
  preview = executionBindingsApi.preview,
) {
  const selection = issue.assigneeAdapterOverrides?.executionBinding;
  if (!selection && !requiresTaskBinding(agent)) return;
  if (!agent || agent.id !== issue.assigneeAgentId) throw new Error("Select the task's current role before starting.");
  if (agent.status === "paused" || agent.status === "terminated") throw new Error("The role is paused or terminated; starting a task does not resume it.");
  if (!issue.projectId || !issue.projectWorkspaceId) throw new Error("Select an explicit local project workspace before starting.");
  if (!selection) throw new Error("Choose and qualify an execution binding in task properties before starting.");
  if (Object.keys(issue.assigneeAdapterOverrides?.adapterConfig ?? {}).length) throw new Error("Bound tasks cannot use custom adapter overrides.");
  const { bindingId, ...requirements } = selection;
  const result = await preview(issue.companyId, { agentId: agent.id, requirements: { ...requirements, preferredBindingIds: [bindingId] } });
  if (result.status !== "selected" || result.selection.bindingId !== bindingId || result.selection.model !== selection.model) {
    throw new Error("The saved execution is no longer qualified. Select a binding again; no fallback was started.");
  }
}

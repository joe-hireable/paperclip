import { describe, expect, it, vi } from "vitest";
import { boundTaskOverrides, requalifyTaskBinding, bindingInvalidationPatch } from "./execution-binding-task";

const selection = { bindingId: "binding-1", model: "exact-model", dataClass: "synthetic" as const, requiredCapabilities: ["text"], reason: "Read fixture", evidenceRefs: ["fixture-spec"] };
const agent = { id: "role-1", status: "idle", runtimeConfig: { executionBindingRequired: true } };
const issue = { companyId: "company-1", assigneeAgentId: agent.id, projectId: "project-1", projectWorkspaceId: "workspace-1", assigneeAdapterOverrides: boundTaskOverrides(selection) };
describe("qualified task dispatch", () => {
  it("serialises a binding with project workspace and no adapter overrides", () => {
    expect(boundTaskOverrides(selection)).toEqual({ executionBinding: selection, useProjectWorkspace: true });
  });
  it("fails before preview for a paused role or missing workspace", async () => {
    const preview = vi.fn();
    await expect(requalifyTaskBinding(issue, { ...agent, status: "paused" }, preview)).rejects.toThrow("paused");
    await expect(requalifyTaskBinding({ ...issue, projectWorkspaceId: null }, agent, preview)).rejects.toThrow("workspace");
    expect(preview).not.toHaveBeenCalled();
  });
  it("requalifies the saved selection and refuses silent replacement", async () => {
    const preview = vi.fn().mockResolvedValue({ status: "selected", selection });
    await requalifyTaskBinding(issue, agent, preview);
    expect(preview).toHaveBeenCalledWith("company-1", { agentId: "role-1", requirements: { model: selection.model, dataClass: selection.dataClass, requiredCapabilities: selection.requiredCapabilities, reason: selection.reason, evidenceRefs: selection.evidenceRefs, preferredBindingIds: ["binding-1"] } });
    preview.mockResolvedValue({ status: "selected", selection: { ...selection, bindingId: "other-account" } });
    await expect(requalifyTaskBinding(issue, agent, preview)).rejects.toThrow("again");
  });
  it("invalidates changed authority while preserving unrelated edits", () => {
    expect(bindingInvalidationPatch(issue, { priority: "high" })).toEqual({ priority: "high" });
    expect(bindingInvalidationPatch(issue, { projectWorkspaceId: "other" })).toEqual({ projectWorkspaceId: "other", assigneeAdapterOverrides: null, status: "backlog" });
    expect(bindingInvalidationPatch(issue, { description: "changed inputs" })).toMatchObject({ status: "backlog", assigneeAdapterOverrides: null });
  });
});

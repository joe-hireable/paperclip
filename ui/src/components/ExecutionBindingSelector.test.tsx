// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionBindingSelector } from "./ExecutionBindingSelector";
const api = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn() }));
vi.mock("../api/execution-bindings", () => ({ executionBindingsApi: api }));
const selection = { bindingId: "b1", model: "exact-model", dataClass: "synthetic" as const, requiredCapabilities: ["text"], reason: "Fixture", evidenceRefs: ["fixture-spec"] };
const binding = { id: "b1", companyId: "c1", name: "Reviewed", accountKey: "account-label", adapterType: "codex_local", models: ["exact-model"], reasoningEffort: "high", enabled: true, allowedAgentIds: ["a1"], capabilities: ["text"], evidenceRefs: ["evidence"], verifiedUntil: "2099-01-01T00:00:00Z", command: "/private/launcher", nativeProfileHome: "/private/profile" };
let root: Root, element: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); element = document.createElement("div"); document.body.append(element); root = createRoot(element); api.list.mockResolvedValue([binding, { ...binding, id: "grok", adapterType: "grok_local" }]); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render(onSelect = vi.fn()) { await act(async () => { root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExecutionBindingSelector companyId="c1" agentId="a1" contextKey="inputs-1" value={selection} onSelect={onSelect} /></QueryClientProvider>); }); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); return onSelect; }
describe("ExecutionBindingSelector", () => {
  it("shows exact supported execution without exposing private profile settings", async () => {
    await render();
    expect(element.textContent).toContain("exact-model");
    expect(element.textContent).toContain("high");
    expect(element.querySelector('option[value="grok"]')).toBeNull();
    expect(element.textContent).not.toContain("/private/");
  });
  it("requires server qualification and exposes expiry/data exclusions", async () => {
    api.preview.mockResolvedValue({ status: "no_selection", candidates: [{ bindingId: "b1", exclusions: ["evidence_expired", "data_class_denied"] }] });
    const onSelect = await render();
    await act(async () => element.querySelector("button")!.click());
    expect(api.preview).toHaveBeenCalledWith("c1", { agentId: "a1", requirements: { ...selection, bindingId: undefined, preferredBindingIds: ["b1"] } });
    expect(onSelect).not.toHaveBeenCalledWith(selection);
    expect(element.textContent).toContain("evidence expired, data class denied");
  });
  it("does not accept a fallback account selected by preview", async () => {
    api.preview.mockResolvedValue({ status: "selected", selection: { ...selection, bindingId: "b2" }, candidates: [] });
    const onSelect = await render();
    await act(async () => element.querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ bindingId: "b2" }));
  });
  it("waits for saved qualification to clear before previewing or saving a replacement", async () => {
    let clear!: () => void;
    const onSelect = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { clear = resolve; })).mockResolvedValue(undefined);
    api.preview.mockResolvedValue({ status: "selected", selection });
    await render(onSelect);
    await act(async () => element.querySelector("button")!.click());
    expect(api.preview).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(null);
    await act(async () => clear());
    expect(api.preview).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls.map(call => call[0])).toEqual([null, selection]);
  });
  it("does not preview or claim qualification when clearing the saved selection fails", async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error("Task update failed"));
    await render(onSelect);
    await act(async () => element.querySelector("button")!.click());
    expect(api.preview).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Task update failed");
    expect(element.textContent).not.toContain("Qualified.");
  });
  it("ignores an in-flight preview after the operator changes classification", async () => {
    let resolve!: (value: unknown) => void;
    api.preview.mockReturnValue(new Promise(done => { resolve = done; }));
    const onSelect = await render();
    await act(async () => element.querySelector("button")!.click());
    await act(async () => { const select = element.querySelector<HTMLSelectElement>('[aria-label="Task data class"]')!; select.value = "private"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => resolve({ status: "selected", selection }));
    expect(onSelect).not.toHaveBeenCalledWith(selection);
  });
});

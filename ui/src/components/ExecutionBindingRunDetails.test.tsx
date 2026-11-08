// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { executionBindingsApi } from "../api/execution-bindings";
import {
  assertUnboundRunRestart,
  ExecutionBindingRunDetails,
  executionBindingPollInterval,
  executionBindingQueryOptions,
} from "./ExecutionBindingRunDetails";

vi.mock("@/lib/router", () => ({
  Link: ({ to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props} />,
}));

const record: NonNullable<Awaited<ReturnType<typeof executionBindingsApi.forRun>>> = {
  releasedAt: null,
  releaseReason: null,
  snapshot: {
    version: 1,
    binding: {
      id: "binding-1", companyId: "company-1", enabled: true,
      name: "Review through Claude Support", accountKey: "claude-support",
      adapterType: "claude_local", command: "/private/launcher",
      nativeProfileHome: "/private/auth", models: ["qualified-model"],
      capabilities: ["text"], dataClasses: ["synthetic"], allowedAgentIds: ["role-1"],
      billingRoute: "native_subscription", evidenceRefs: ["qualification-fixture"],
      verifiedUntil: "2026-09-11T00:00:00Z", createdAt: new Date("2026-09-10T00:00:00Z"),
    },
    selection: {
      bindingId: "binding-1", model: "qualified-model", requiredCapabilities: ["text"],
      dataClass: "synthetic", reason: "Review the synthetic fixture", evidenceRefs: ["task-spec"],
    },
    adapterConfig: { env: { SECRET: "must-not-render" }, cwd: "/private/workspace" },
    sessionKey: "private-session", resolvedAt: "2026-09-10T10:00:00Z",
  },
};

describe("execution binding run details", () => {
  it("fetches the final reservation when a queued null becomes terminal before the next poll", async () => {
    const lookup = vi.spyOn(executionBindingsApi, "forRun").mockResolvedValueOnce(null).mockResolvedValue(record);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const observer = new QueryObserver(client, executionBindingQueryOptions("company-1", "run-1", "queued"));
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(null));
      observer.setOptions(executionBindingQueryOptions("company-1", "run-1", "succeeded"));
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.releasedAt).toBe(null));
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(observer.getCurrentResult().data).toEqual(record);
    } finally {
      unsubscribe(); client.clear(); lookup.mockRestore();
    }
  });
  it("keeps a successful foreground run visibly reserved and omits private snapshot fields", () => {
    const html = renderToStaticMarkup(<ExecutionBindingRunDetails record={record} taskId="task-1" runStatus="succeeded" loading={false} failed={false} />);
    expect(html).toContain("Execution finished; account still reserved");
    expect(html).toContain("Selected model");
    expect(html).toContain("Not independently verified");
    expect(html).toContain("claude-support");
    expect(html).toContain("task-spec");
    expect(html).toContain("qualification-fixture");
    expect(html).toContain('/issues/task-1');
    expect(html).not.toMatch(/must-not-render|private-session|\/private\//);
    expect(html).not.toContain("force release");
  });

  it("distinguishes no binding from a failed lookup, including a stale cached record", () => {
    expect(renderToStaticMarkup(<ExecutionBindingRunDetails record={null} runStatus="failed" loading={false} failed={false} />)).toBe("");
    expect(renderToStaticMarkup(<ExecutionBindingRunDetails record={[] as never} runStatus="succeeded" loading={false} failed={false} />)).toBe("");
    expect(renderToStaticMarkup(<ExecutionBindingRunDetails record={{ releasedAt: null, releaseReason: null } as never} runStatus="succeeded" loading={false} failed={false} />)).toBe("");
    const html = renderToStaticMarkup(<ExecutionBindingRunDetails record={{ ...record, releasedAt: new Date() }} runStatus="failed" loading={false} failed />);
    expect(html).toContain("Could not verify the account reservation");
    expect(html).not.toContain("Account reservation released");
    expect(renderToStaticMarkup(<ExecutionBindingRunDetails record={undefined} runStatus="failed" loading failed={false} />)).toContain("Checking account reservation");
  });

  it("shows release evidence and polls retained reservations even after foreground completion", () => {
    const released = { ...record, releasedAt: new Date("2026-09-10T10:01:00Z"), releaseReason: "execution_settled_process_tree_gone" };
    expect(renderToStaticMarkup(<ExecutionBindingRunDetails record={released} runStatus="succeeded" loading={false} failed={false} />)).toContain("execution_settled_process_tree_gone");
    expect(executionBindingPollInterval(record, "succeeded")).toBe(3000);
    expect(executionBindingPollInterval(released, "succeeded")).toBe(false);
    expect(executionBindingPollInterval(null, "running")).toBe(3000);
    expect(executionBindingPollInterval(undefined, "failed")).toBe(3000);
  });

  it("requires a fresh conclusively unbound lookup before any run restart", async () => {
    const lookup = vi.spyOn(executionBindingsApi, "forRun");
    try {
      lookup.mockResolvedValue(record);
      await expect(assertUnboundRunRestart("company-1", "run-1")).rejects.toThrow("fresh task attempt");
      lookup.mockRejectedValue(new Error("lookup unavailable"));
      await expect(assertUnboundRunRestart("company-1", "run-1")).rejects.toThrow("lookup unavailable");
      lookup.mockResolvedValue(null);
      await expect(assertUnboundRunRestart("company-1", "run-1")).resolves.toBeUndefined();
      expect(lookup).toHaveBeenLastCalledWith("company-1", "run-1");
    } finally {
      lookup.mockRestore();
    }
  });
});

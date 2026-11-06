import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentKeySchema } from "@paperclipai/shared";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("coordinator run-only scope", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("retains exact signed scope without allowing a persistent key", () => {
    vi.stubEnv(
      "PAPERCLIP_AGENT_JWT_SECRET",
      "synthetic-coordinator-test-secret",
    );
    const scope = {
      kind: "project_coordinator",
      projectId: randomUUID(),
      intakeIssueId: randomUUID(),
      attemptIssueId: randomUUID(),
      authorityDigest: "a".repeat(64),
    };
    const token = createLocalAgentJwt(
      randomUUID(),
      randomUUID(),
      "claude_local",
      randomUUID(),
      "synthetic-board",
      scope as never,
    );
    expect(verifyLocalAgentJwt(token!)?.key_scope).toEqual(scope);
    expect(
      createAgentKeySchema.safeParse({ name: "forged", scope }).success,
    ).toBe(false);
  });
  it.each([
    { kind: "project_coordinator" },
    { kind: "project_coordinator", projectId: "not-a-project" },
    {
      kind: "project_coordinator",
      projectId: randomUUID(),
      intakeIssueId: randomUUID(),
      attemptIssueId: randomUUID(),
      authorityDigest: "a".repeat(64),
      allowedRoutes: ["*"],
    },
  ])("rejects malformed or expanded signed scope %#", (scope) => {
    vi.stubEnv(
      "PAPERCLIP_AGENT_JWT_SECRET",
      "synthetic-coordinator-test-secret",
    );
    const token = createLocalAgentJwt(
      randomUUID(),
      randomUUID(),
      "claude_local",
      randomUUID(),
      "synthetic-board",
      scope as never,
    );
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});

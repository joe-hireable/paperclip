import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  documents,
  executionBindings,
  heartbeatRuns,
  issueDocuments,
  issues,
  runExecutionBindings,
} from "@paperclipai/db";
import { intelligentRoutingContracts } from "@paperclipai/db/schema/intelligent_routing";
import type { ExecutionBindingSnapshot } from "@paperclipai/shared/execution-bindings";
import type { IntelligentRoutingRequirements } from "@paperclipai/shared/intelligent-routing";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  executionBindingService,
  resolveExecutionBindingSnapshot,
} from "../services/execution-bindings.js";
import {
  intelligentRoutingContractService,
  type IntelligentRoutingContractInput,
} from "../services/intelligent-routing-contracts.js";
import { intelligentRoutingDigest as digest } from "../services/intelligent-routing-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported)
  console.warn(
    `Intelligent routing execution DB tests unavailable: ${support.reason}`,
  );

describeDb(
  "intelligent routing authority at reservation and native-launch boundaries",
  () => {
    let db: ReturnType<typeof createDb>;
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "intelligent-routing-execution-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    });

    async function fixture(
      options: {
        approve?: boolean;
        available?: boolean;
        material?: {
          adapterType: "claude_local";
          cwd: string;
          instructionsFilePath: string;
          command: string;
          nativeProfileHome: string;
          runtimeFilePaths: string[];
        };
      } = {},
    ) {
      const [company] = await db
        .insert(companies)
        .values({
          name: "Synthetic routing authority",
          issuePrefix: randomUUID().slice(0, 8),
          defaultResponsibleUserId: "synthetic-board",
        })
        .returning();
      const roles = await db
        .insert(agents)
        .values(
          ["Producer", "Other assignee"].map((name) => ({
            companyId: company!.id,
            name,
            role: "engineer",
            status: "idle",
            adapterType: "codex_local",
            adapterConfig: {
              cwd: options.material?.cwd ?? "/synthetic/no-dispatch",
              instructionsFilePath:
                options.material?.instructionsFilePath ?? "/synthetic/ROLE.md",
            },
            // A stored routing contract itself must require its binding, regardless of this legacy flag.
            runtimeConfig: { executionBindingRequired: false },
            permissions: { canCreateAgents: false },
          })),
        )
        .returning();
      const agent = roles[0]!;
      const runtimeOptions = options.material
        ? {}
        : { runtimeFingerprint: async () => "a".repeat(64) };
      const bindings = executionBindingService(db, runtimeOptions);
      const binding = await bindings.create(
        company!.id,
        {
          name: "Synthetic exact frontier route",
          accountKey: `synthetic-account-${randomUUID()}`,
          adapterType: options.material?.adapterType ?? "codex_local",
          command: options.material?.command ?? "/synthetic/never-executed",
          nativeProfileHome:
            options.material?.nativeProfileHome ?? "/synthetic/profile",
          ...(options.material
            ? { runtimeFilePaths: options.material.runtimeFilePaths }
            : {}),
          models: ["synthetic-frontier-model"],
          reasoningEffort: "high",
          capabilities: ["shell"],
          dataClasses: ["synthetic"],
          allowedAgentIds: roles.map((role) => role.id),
          billingRoute: "native_subscription",
          evidenceRefs: ["fixture://binding-qualification"],
          verifiedUntil: "2099-01-01T00:00:00.000Z",
        },
        { actorType: "user", actorId: "synthetic-board" },
      );
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company!.id,
          title: "Synthetic controlled edit",
          description: "Change only the owned fixture.",
          status: "todo",
          assigneeAgentId: agent.id,
          assigneeAdapterOverrides: {},
        })
        .returning();
      const [document] = await db
        .insert(documents)
        .values({
          companyId: company!.id,
          title: "Acceptance plan",
          latestBody: "Synthetic acceptance criteria",
          latestRevisionId: randomUUID(),
        })
        .returning();
      await db.insert(issueDocuments).values({
        companyId: company!.id,
        issueId: issue!.id,
        documentId: document!.id,
        key: "plan",
      });
      const contracts = intelligentRoutingContractService(db, {
        resolveSnapshot: resolveExecutionBindingSnapshot,
        ...runtimeOptions,
      });
      const context = await contracts.context(company!.id, issue!.id);
      const configurationDigest = context.profiles.find(
        (entry) => entry.bindingId === binding.id,
      )?.configurationDigest;
      expect(configurationDigest).toMatch(/^[a-f0-9]{64}$/);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
      const profile = {
        version: 1 as const,
        bindingId: binding.id,
        accountKey: binding.accountKey,
        harness: binding.adapterType,
        model: binding.models[0]!,
        expectedServedModelId: "synthetic-frontier-model",
        effort: "high" as const,
        configurationDigest: configurationDigest!,
        modelDeployment: "frontier" as const,
        deliveryMode: "static_native" as const,
      };
      const profileDigest = digest(profile);
      const requirements: IntelligentRoutingRequirements = {
        version: 1,
        taskFamily: "synthetic-edit",
        benchmarkDigest: digest("synthetic-benchmark"),
        benchmarkCaseDigests: Array.from({ length: 20 }, (_, index) =>
          digest(`synthetic-case-${index}`),
        ),
        rubricDigest: digest("synthetic-rubric"),
        evaluationPolicyDigest: digest("synthetic-evaluation-policy"),
        trustedEvaluatorProfileDigests: [digest("synthetic-verifier")],
        frontierReviewerProfileDigests: [digest("synthetic-frontier-reviewer")],
        requiredCapabilities: ["shell"],
        requiredModalities: ["text"],
        requiredContextTokens: 10000,
        dataClass: "synthetic",
        risk: "low",
        minimumQualityLowerBound: 0.7,
        minimumSampleCount: 20,
        requireFrontierReview: true,
        maximumObservationAgeMs: 60000,
        frontierBaselineProfileDigests: [],
      };
      const input: IntelligentRoutingContractInput = {
        expectedInputDigest: context.inputDigest,
        expectedRevision: context.latestRevision,
        requirements,
        candidates: [
          {
            profile,
            advertisedCapabilities: ["shell"],
            baseline: null,
            observation: {
              version: 1,
              profileDigest,
              observedAt: now.toISOString(),
              expiresAt,
              available: options.available ?? true,
              availableCapacity: 1,
              remainingQuota: null,
              billingRoute: "native_subscription",
              billingApproved: true,
            },
            evaluations: [
              {
                version: 1,
                id: "synthetic-complete-evaluation",
                profileDigest,
                taskFamily: requirements.taskFamily,
                benchmarkDigest: requirements.benchmarkDigest,
                rubricDigest: requirements.rubricDigest,
                evaluationPolicyDigest: requirements.evaluationPolicyDigest,
                capabilities: ["shell"],
                modalities: ["text"],
                contextTokens: 10000,
                risks: ["low"],
                recordedAt: now.toISOString(),
                expiresAt,
                evidenceRef: "fixture://held-out-evaluation",
                evaluatorProfileDigest:
                  requirements.trustedEvaluatorProfileDigests[0]!,
                servedModelId: profile.expectedServedModelId,
                source: "controlled_evaluation",
                split: "held_out",
                leakageCheck: "verified_clear",
                cases: requirements.benchmarkCaseDigests.map((caseDigest) => ({
                  caseDigest,
                  passed: true,
                  endToEndMs: 100,
                  marginalCostMicrosUsd: null,
                  frontierReviewerProfileDigest:
                    requirements.frontierReviewerProfileDigests[0]!,
                })),
              },
            ],
          },
        ],
      };
      const contract =
        options.approve === false
          ? null
          : await contracts.create(
              company!.id,
              issue!.id,
              input,
              "synthetic-board",
            );
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: company!.id,
          agentId: agent.id,
          status: "running",
          contextSnapshot: { issueId: issue!.id },
        })
        .returning();
      return {
        company: company!,
        agent,
        otherAgent: roles[1]!,
        binding,
        issue: issue!,
        document: document!,
        bindings,
        contracts,
        input,
        contract,
        run: run!,
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function acquire(f: Fixture): Promise<ExecutionBindingSnapshot> {
      const snapshot = await f.bindings.acquire(f.run, f.agent);
      expect(snapshot).not.toBeNull();
      return snapshot!;
    }
    async function assertNoLease(f: Fixture) {
      expect(
        await db
          .select()
          .from(runExecutionBindings)
          .where(eq(runExecutionBindings.runId, f.run.id)),
      ).toEqual([]);
    }

    it("persists a selected contract receipt on the actual reserved run and revalidates before launch", async () => {
      const f = await fixture();
      expect(f.contract!.decision.status).toBe("selected");
      const snapshot = await acquire(f);
      expect(snapshot.routingReceipt).toMatchObject({
        contractId: f.contract!.id,
        revision: 1,
        inputDigest: f.contract!.inputDigest,
      });
      expect(snapshot.adapterConfig).toMatchObject({
        command: "/synthetic/never-executed",
        model: "synthetic-frontier-model",
        modelReasoningEffort: "high",
      });
      const [lease] = await db
        .select()
        .from(runExecutionBindings)
        .where(eq(runExecutionBindings.runId, f.run.id));
      expect(lease!.snapshot.routingReceipt).toEqual(snapshot.routingReceipt);
      expect(lease!.processPid).toBeNull();
      await expect(
        f.bindings.assertBeforeLaunch(f.run, f.agent, snapshot),
      ).resolves.toBeUndefined();
    });

    it("accepts the projected agent shape used by the real heartbeat while pinning original role authority separately", async () => {
      const f = await fixture();
      const snapshot = await acquire(f);
      const projectedAgent = {
        ...f.agent,
        adapterType: snapshot.binding.adapterType,
        adapterConfig: snapshot.adapterConfig,
      };
      expect(projectedAgent.adapterConfig).not.toEqual(f.agent.adapterConfig);
      expect(snapshot.routingAuthorityDigest).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        f.bindings.assertBeforeLaunch(
          f.run,
          projectedAgent,
          snapshot,
          snapshot.adapterConfig,
        ),
      ).resolves.toBeUndefined();
    });

    it("reuses the dispatch gate transaction without waiting for its own locked issue row", async () => {
      const f = await fixture();
      const snapshot = await acquire(f);
      let pendingCheck: Promise<void> | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(issues)
            .where(eq(issues.id, f.issue.id))
            .for("update");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Authority check deadlocked against its dispatch gate",
                  ),
                ),
              2000,
            );
          });
          pendingCheck = f.bindings.assertBeforeLaunch(
            f.run,
            f.agent,
            snapshot,
            snapshot.adapterConfig,
            tx as unknown as typeof db,
          );
          try {
            await Promise.race([pendingCheck, deadline]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        });
      } finally {
        // A regression that takes a second transaction is unblocked by the outer
        // rollback, so this failing test never leaves a database request hanging.
        await pendingCheck?.catch(() => {});
      }
    });

    it.each([
      "qualified instructions",
      "instructions changed after qualification",
      "adapter refusal after reservation",
    ] as const)(
      "runs the complete static native heartbeat with %s",
      async (instructionState) => {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), "paperclip-routing-heartbeat-"),
        );
        const material = {
          adapterType: "claude_local" as const,
          cwd: path.join(root, "workspace"),
          instructionsFilePath: path.join(root, "ROLE.md"),
          command: path.join(root, "synthetic-launcher"),
          nativeProfileHome: path.join(root, "native-profile"),
          runtimeFilePaths: [path.join(root, "synthetic-runtime")],
        };
        await fs.mkdir(material.cwd);
        await fs.mkdir(material.nativeProfileHome);
        await fs.writeFile(
          material.instructionsFilePath,
          "Complete only this synthetic task.\n",
        );
        await fs.writeFile(
          material.command,
          "Synthetic launcher: never executed.\n",
          { mode: 0o700 },
        );
        await fs.writeFile(
          material.runtimeFilePaths[0]!,
          "Synthetic installed runtime: never executed.\n",
          { mode: 0o700 },
        );
        await fs.writeFile(
          path.join(material.nativeProfileHome, "settings.json"),
          "{}\n",
        );
        await fs.writeFile(
          path.join(material.cwd, "AGENTS.md"),
          "Synthetic workspace instructions.\n",
        );
        vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
        vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
        const { registerServerAdapter, unregisterServerAdapter } =
          await import("../adapters/index.js");
        const { heartbeatService } = await import("../services/heartbeat.js");
        const heartbeat = heartbeatService(db);
        const execute = vi.fn<ServerAdapterModule["execute"]>();
        registerServerAdapter({
          type: "claude_local",
          supportsLocalAgentJwt: true,
          execute,
          testEnvironment: async () => ({
            adapterType: "claude_local",
            status: "pass",
            checks: [],
            testedAt: new Date().toISOString(),
          }),
        });
        try {
          const f = await fixture({ material });
          expect(f.contract!.decision.status).toBe("selected");
          // The fixture's reservation-only run is unrelated to this real heartbeat.
          await db
            .update(heartbeatRuns)
            .set({ status: "cancelled", finishedAt: new Date() })
            .where(eq(heartbeatRuns.id, f.run.id));
          if (instructionState === "instructions changed after qualification") {
            await fs.writeFile(
              material.instructionsFilePath,
              "Instructions replaced after qualification.\n",
            );
          }
          execute.mockImplementation(async (context) => {
            expect(context.config.cwd).toBe(material.cwd);
            expect(context.config.paperclipRuntimeSkills).toEqual([]);
            expect(context.runtimeTools).toBeUndefined();
            expect(context.runtimeMcp).toBeUndefined();
            expect(context.context.paperclipManagedMcp).toBeUndefined();
            expect(context.context.paperclipRuntimeTools).toBeUndefined();
            expect(context.config.model).toBe("synthetic-frontier-model");
            expect(context.config.effort).toBe("high");
            expect(context.config.command).toBe(material.command);
            const [lease] = await db
              .select()
              .from(runExecutionBindings)
              .where(eq(runExecutionBindings.runId, context.runId));
            expect(lease!.snapshot.routingReceipt?.contractId).toBe(
              f.contract!.id,
            );
            if (instructionState === "adapter refusal after reservation") {
              throw Object.assign(
                new Error("intelligent_routing_instructions_unavailable"),
                { code: "intelligent_routing_instructions_unavailable" },
              );
            }
            // A deterministic child proves the actual cwd and process lifecycle;
            // no native harness, provider request or model is started by this test.
            const child = spawn(
              process.execPath,
              ["-e", "process.stdout.write(process.cwd())"],
              {
                cwd: String(context.config.cwd),
                detached: true,
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
            let actualCwd = "";
            child.stdout!.setEncoding("utf8");
            child.stdout!.on("data", (chunk: string) => {
              actualCwd += chunk;
            });
            const closed = once(child, "close");
            await context.onSpawn?.({
              pid: child.pid!,
              processGroupId: child.pid!,
              startedAt: new Date().toISOString(),
            });
            const [exitCode] = await closed;
            expect(exitCode).toBe(0);
            expect(actualCwd).toBe(material.cwd);
            await db
              .update(issues)
              .set({ status: "done" })
              .where(eq(issues.id, f.issue.id));
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              provider: "claude_local",
              model: "synthetic-frontier-model",
              summary: "Synthetic static delivery passed",
              resultJson: { proof: "static-native-contract", actualCwd },
              sessionId: randomUUID(),
            };
          });
          const run = await heartbeat.invoke(
            f.agent.id,
            "on_demand",
            { issueId: f.issue.id },
            "manual",
          );
          expect(run).not.toBeNull();
          let finished = await heartbeat.getRun(run!.id);
          for (
            let attempt = 0;
            attempt < 200 &&
            finished &&
            ["queued", "running"].includes(finished.status);
            attempt += 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            finished = await heartbeat.getRun(run!.id);
          }
          if (instructionState !== "qualified instructions") {
            const adapterRefused =
              instructionState === "adapter refusal after reservation";
            expect(finished).toMatchObject({
              status: "failed",
              errorCode: adapterRefused
                ? "intelligent_routing_instructions_unavailable"
                : "routing_contract_configuration_changed",
            });
            await heartbeat.drainActiveRunExecutions();
            expect(execute).toHaveBeenCalledTimes(adapterRefused ? 1 : 0);
            const attempts = await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.agentId, f.agent.id));
            expect(
              attempts
                .filter((attempt) => attempt.id !== f.run.id)
                .map((attempt) => ({ id: attempt.id, status: attempt.status })),
            ).toEqual([{ id: run!.id, status: "failed" }]);
            const leases = await db
              .select()
              .from(runExecutionBindings)
              .where(eq(runExecutionBindings.runId, run!.id));
            expect(leases).toHaveLength(adapterRefused ? 1 : 0);
            if (adapterRefused) expect(leases[0]!.processPid).toBeNull();
            return;
          }
          expect(
            finished,
            `Synthetic heartbeat error: ${finished?.errorCode}: ${finished?.error}`,
          ).toMatchObject({
            status: "succeeded",
            resultJson: {
              proof: "static-native-contract",
              actualCwd: material.cwd,
            },
          });
          expect(execute).toHaveBeenCalledTimes(1);
          const [lease] = await db
            .select()
            .from(runExecutionBindings)
            .where(eq(runExecutionBindings.runId, run!.id));
          expect(lease!.snapshot.routingReceipt).toMatchObject({
            contractId: f.contract!.id,
            revision: 1,
            inputDigest: f.contract!.inputDigest,
          });
          expect(lease!.processPid).toBeGreaterThan(0);
        } finally {
          await heartbeat.drainActiveRunExecutions();
          unregisterServerAdapter("claude_local");
          vi.unstubAllEnvs();
          await fs.rm(root, { recursive: true, force: true });
        }
      },
      30_000,
    );

    it.each([
      ["instructionsFilePath", "/synthetic/OTHER-ROLE.md"],
      ["cwd", "/synthetic/other-workspace"],
      ["filesystemScope", "unrestricted"],
      ["dangerouslyBypassApprovalsAndSandbox", true],
    ] as const)(
      "rejects a runtime %s override after heartbeat projects the chosen account",
      async (key, value) => {
        const f = await fixture();
        const snapshot = await acquire(f);
        const projectedAgent = {
          ...f.agent,
          adapterType: snapshot.binding.adapterType,
          adapterConfig: snapshot.adapterConfig,
        };
        await expect(
          f.bindings.assertBeforeLaunch(f.run, projectedAgent, snapshot, {
            ...snapshot.adapterConfig,
            [key]: value,
          }),
        ).rejects.toMatchObject({
          code: "intelligent_routing_configuration_changed",
        });
      },
    );

    it("keeps preview read-only until an identified board creates the contract", async () => {
      const f = await fixture({ approve: false });
      expect(
        (await f.contracts.preview(f.company.id, f.issue.id, f.input)).decision
          .status,
      ).toBe("selected");
      expect(await f.contracts.latest(f.company.id, f.issue.id)).toBeNull();
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issue.id));
      expect(issue!.assigneeAdapterOverrides).toEqual({});
      await assertNoLease(f);
    });

    it("atomically applies exactly one concurrent first revision and its matching issue override", async () => {
      const f = await fixture({ approve: false });
      const results = await Promise.allSettled([
        f.contracts.create(
          f.company.id,
          f.issue.id,
          f.input,
          "first-synthetic-board",
        ),
        f.contracts.create(
          f.company.id,
          f.issue.id,
          f.input,
          "second-synthetic-board",
        ),
      ]);
      const successes = results.filter(
        (result) => result.status === "fulfilled",
      );
      const failures = results.filter((result) => result.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.reason).toMatchObject({ status: 409 });
      const rows = await db
        .select()
        .from(intelligentRoutingContracts)
        .where(eq(intelligentRoutingContracts.issueId, f.issue.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revision).toBe(1);
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issue.id));
      const decision = rows[0]!.decision;
      if (decision.status !== "selected")
        throw new Error("Expected selected fixture");
      expect(issue!.assigneeAdapterOverrides).toEqual({
        executionBinding: decision.selection,
      });
      const snapshot = await acquire(f);
      expect(snapshot.routingReceipt?.contractId).toBe(rows[0]!.id);
    });

    it("a rejected exact configuration leaves neither a contract nor a half-applied binding", async () => {
      const f = await fixture({ approve: false });
      const input = structuredClone(f.input);
      input.candidates[0]!.profile.configurationDigest = digest(
        "unqualified configuration",
      );
      await expect(
        f.contracts.create(f.company.id, f.issue.id, input, "synthetic-board"),
      ).rejects.toMatchObject({ status: 409 });
      expect(await f.contracts.latest(f.company.id, f.issue.id)).toBeNull();
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issue.id));
      expect(issue!.assigneeAdapterOverrides).toEqual({});
      await assertNoLease(f);
    });

    it.each(["removed", "tampered"] as const)(
      "refuses %s issue selection even when the role does not require a legacy binding",
      async (change) => {
        const f = await fixture();
        const selected = f.contract!.decision;
        if (selected.status !== "selected")
          throw new Error("Expected selected fixture");
        await db
          .update(issues)
          .set({
            assigneeAdapterOverrides:
              change === "removed"
                ? {}
                : {
                    executionBinding: {
                      ...selected.selection,
                      reason: "Changed after authorisation",
                    },
                  },
          })
          .where(eq(issues.id, f.issue.id));
        await expect(f.bindings.acquire(f.run, f.agent)).rejects.toMatchObject({
          code:
            change === "removed"
              ? "execution_binding_required"
              : "routing_contract_selection_changed",
        });
        await assertNoLease(f);
      },
    );

    it("a no-selection contract blocks unbound fallback and records a blocked issue", async () => {
      const f = await fixture({ available: false });
      expect(f.contract!.decision.status).toBe("no_selection");
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issue.id));
      expect(issue!.status).toBe("blocked");
      expect(issue!.assigneeAdapterOverrides).toEqual({});
      await expect(f.bindings.acquire(f.run, f.agent)).rejects.toMatchObject({
        code: "execution_binding_required",
      });
      await assertNoLease(f);
    });

    it("changing task input before acquisition invalidates the board decision", async () => {
      const f = await fixture();
      await db
        .update(issues)
        .set({ description: "A materially different task" })
        .where(eq(issues.id, f.issue.id));
      await expect(f.bindings.acquire(f.run, f.agent)).rejects.toMatchObject({
        code: "routing_contract_input_changed",
      });
      await assertNoLease(f);
    });

    it("changing role permissions after preparation cannot borrow the stale in-memory agent", async () => {
      const f = await fixture();
      await db
        .update(agents)
        .set({ permissions: { canCreateAgents: true } })
        .where(eq(agents.id, f.agent.id));
      await expect(f.bindings.acquire(f.run, f.agent)).rejects.toMatchObject({
        code: "intelligent_routing_role_changed",
      });
      await assertNoLease(f);
    });

    it.each([
      ["task input", "routing_contract_input_changed"],
      ["linked document", "routing_contract_input_changed"],
      ["assignment", "routing_contract_scope"],
      ["role configuration", "intelligent_routing_role_changed"],
      ["role permissions", "intelligent_routing_role_changed"],
      ["binding configuration", "intelligent_routing_configuration_changed"],
      ["removed selection", "routing_contract_selection_changed"],
      ["deleted contract", "intelligent_routing_contract_changed"],
      ["expired observation", "routing_contract_qualification_expired"],
    ] as const)(
      "blocks a changed %s between reservation and native dispatch",
      async (change, code) => {
        const f = await fixture();
        const snapshot = await acquire(f);
        if (change === "task input")
          await db
            .update(issues)
            .set({ title: "Changed synthetic task" })
            .where(eq(issues.id, f.issue.id));
        if (change === "linked document")
          await db
            .update(documents)
            .set({
              latestBody: "Different acceptance criteria",
              latestRevisionId: randomUUID(),
              latestRevisionNumber: 2,
            })
            .where(eq(documents.id, f.document.id));
        if (change === "assignment")
          await db
            .update(issues)
            .set({ assigneeAgentId: f.otherAgent.id })
            .where(eq(issues.id, f.issue.id));
        if (change === "role configuration")
          await db
            .update(agents)
            .set({
              adapterConfig: {
                ...f.agent.adapterConfig,
                cwd: "/synthetic/changed",
              },
            })
            .where(eq(agents.id, f.agent.id));
        if (change === "role permissions")
          await db
            .update(agents)
            .set({ permissions: { canCreateAgents: true } })
            .where(eq(agents.id, f.agent.id));
        if (change === "binding configuration") {
          const [row] = await db
            .select()
            .from(executionBindings)
            .where(eq(executionBindings.id, f.binding.id));
          await db
            .update(executionBindings)
            .set({
              definition: {
                ...row!.definition,
                nativeProfileHome: "/synthetic/changed-profile",
              },
            })
            .where(eq(executionBindings.id, f.binding.id));
        }
        if (change === "removed selection")
          await db
            .update(issues)
            .set({ assigneeAdapterOverrides: {} })
            .where(eq(issues.id, f.issue.id));
        if (change === "deleted contract")
          await db
            .delete(intelligentRoutingContracts)
            .where(eq(intelligentRoutingContracts.id, f.contract!.id));
        if (change === "expired observation") {
          const candidates = structuredClone(f.input.candidates);
          candidates[0]!.observation.observedAt = new Date(
            Date.now() - 120_000,
          ).toISOString();
          candidates[0]!.observation.expiresAt = new Date(
            Date.now() - 60_000,
          ).toISOString();
          await db
            .update(intelligentRoutingContracts)
            .set({ candidateEvidenceSnapshot: candidates })
            .where(eq(intelligentRoutingContracts.id, f.contract!.id));
        }
        await expect(
          f.bindings.assertBeforeLaunch(f.run, f.agent, snapshot),
        ).rejects.toMatchObject({ code });
      },
    );

    it("cannot launch under a superseded contract receipt even if the newly selected model is unchanged", async () => {
      const f = await fixture();
      const snapshot = await acquire(f);
      const context = await f.contracts.context(f.company.id, f.issue.id);
      const newer = await f.contracts.create(
        f.company.id,
        f.issue.id,
        {
          ...f.input,
          expectedRevision: context.latestRevision,
          expectedInputDigest: context.inputDigest,
        },
        "synthetic-board",
      );
      expect(newer.revision).toBe(2);
      await expect(
        f.bindings.assertBeforeLaunch(f.run, f.agent, snapshot),
      ).rejects.toMatchObject({ code: "intelligent_routing_contract_changed" });
    });

    it("refuses an old unreceipted reservation if a contract is introduced before launch", async () => {
      const f = await fixture({ approve: false });
      await db
        .update(issues)
        .set({
          assigneeAdapterOverrides: {
            executionBinding: {
              bindingId: f.binding.id,
              model: f.binding.models[0]!,
              requiredCapabilities: ["shell"],
              dataClass: "synthetic",
              reason: "Explicit legacy binding",
              evidenceRefs: ["fixture://explicit-binding"],
            },
          },
        })
        .where(eq(issues.id, f.issue.id));
      const snapshot = await acquire(f);
      expect(snapshot.routingReceipt).toBeUndefined();
      await f.contracts.create(
        f.company.id,
        f.issue.id,
        f.input,
        "synthetic-board",
      );
      await expect(
        f.bindings.assertBeforeLaunch(f.run, f.agent, snapshot),
      ).rejects.toMatchObject({ code: "intelligent_routing_contract_changed" });
    });

    it("guards cross-company routing context, creation and foreign binding selection", async () => {
      const f = await fixture(),
        foreign = await fixture();
      await expect(
        f.contracts.context(foreign.company.id, f.issue.id),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        f.contracts.create(
          foreign.company.id,
          f.issue.id,
          f.input,
          "synthetic-board",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const candidates = structuredClone(f.input.candidates);
      candidates[0]!.profile.bindingId = foreign.binding.id;
      const context = await f.contracts.context(f.company.id, f.issue.id);
      await expect(
        f.contracts.create(
          f.company.id,
          f.issue.id,
          { ...f.input, candidates, expectedRevision: context.latestRevision },
          "synthetic-board",
        ),
      ).rejects.toMatchObject({ status: 422 });
      const selection = f.contract!.decision;
      if (selection.status !== "selected")
        throw new Error("Expected selected fixture");
      await db
        .update(issues)
        .set({
          assigneeAdapterOverrides: {
            executionBinding: {
              ...selection.selection,
              bindingId: foreign.binding.id,
            },
          },
        })
        .where(eq(issues.id, f.issue.id));
      await expect(f.bindings.acquire(f.run, f.agent)).rejects.toMatchObject({
        code: "execution_binding_scope",
      });
      await assertNoLease(f);
    });

    it("does not treat a foreign issue ID as permission to use the unbound legacy adapter", async () => {
      const f = await fixture(),
        foreign = await fixture();
      await expect(
        f.bindings.acquire(
          { ...f.run, contextSnapshot: { issueId: foreign.issue.id } },
          f.agent,
        ),
      ).rejects.toMatchObject({ code: "execution_binding_scope" });
      await assertNoLease(f);
    });

    it("preserves existing explicit binding execution when no intelligent routing contract exists", async () => {
      const f = await fixture({ approve: false });
      await db
        .update(issues)
        .set({
          assigneeAdapterOverrides: {
            executionBinding: {
              bindingId: f.binding.id,
              model: f.binding.models[0]!,
              requiredCapabilities: ["shell"],
              dataClass: "synthetic",
              reason: "Explicit legacy binding",
              evidenceRefs: ["fixture://explicit-binding"],
            },
          },
        })
        .where(eq(issues.id, f.issue.id));
      const snapshot = await acquire(f);
      expect(snapshot.routingReceipt).toBeUndefined();
      await expect(
        f.bindings.assertBeforeLaunch(f.run, f.agent, snapshot),
      ).resolves.toBeUndefined();
    });
  },
);

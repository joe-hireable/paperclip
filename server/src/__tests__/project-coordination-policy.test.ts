import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  companySkills,
  companySkillVersions,
  executionBindings,
  projects,
  projectWorkspaces,
  routines,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import { projectRoutes } from "../routes/projects.js";
import { projectService } from "../services/projects.js";

describe("project coordination policy PostgreSQL/API", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-project-conversation-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(),
      projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic",
      issuePrefix: `T${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      membershipRole: "admin",
    });
    await db
      .insert(projects)
      .values({ id: projectId, companyId, name: "Synthetic project" });
    const app = (kind = "admin") => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor =
          kind === "agent"
            ? {
                type: "agent",
                agentId: randomUUID(),
                companyId,
                source: "agent_key",
              }
            : {
                type: "board",
                source: "session",
                userId: "board-user",
                isInstanceAdmin: false,
                companyIds: [companyId],
                memberships: [
                  {
                    companyId,
                    membershipRole: kind === "viewer" ? "viewer" : "admin",
                    status: "active",
                  },
                ],
              };
        next();
      });
      app.use("/api", projectRoutes(db));
      app.use("/api", routineRoutes(db));
      app.use(errorHandler);
      return app;
    };
    const url = `/api/projects/${projectId}/coordination-policy`;
    return { companyId, projectId, app, url };
  }

  async function configuredFixture() {
    const f = await fixture();
    const leadAgentId = randomUUID(),
      bindingId = randomUUID(),
      skillId = randomUUID(),
      versionId = randomUUID();
    await db.insert(agents).values({
      id: leadAgentId,
      companyId: f.companyId,
      name: "Synthetic lead",
      adapterType: "claude_local",
      status: "paused",
    });
    await db.insert(executionBindings).values({
      id: bindingId,
      companyId: f.companyId,
      enabled: true,
      profileRoots: ["/synthetic/profile"],
      definition: {
        name: "Synthetic",
        accountKey: "synthetic",
        adapterType: "claude_local",
        command: "/synthetic/never-run",
        nativeProfileHome: "/synthetic/private-home",
        models: ["synthetic-model"],
        reasoningEffort: "high",
        capabilities: ["text"],
        dataClasses: ["synthetic"],
        allowedAgentIds: [leadAgentId],
        billingRoute: "native_subscription",
        evidenceRefs: ["synthetic-only"],
        verifiedUntil: "2099-01-01T00:00:00.000Z",
      },
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId: f.companyId,
      key: "synthetic-skill",
      slug: "synthetic-skill",
      name: "Synthetic",
      markdown: "Synthetic",
    });
    await db.insert(companySkillVersions).values({
      id: versionId,
      companyId: f.companyId,
      companySkillId: skillId,
      revisionNumber: 1,
      fileInventory: [{ path: "SKILL.md", content: "Synthetic" }] as never,
    });
    const body = {
      expectedRevision: 0,
      leadAgentId,
      policy: {
        version: 1,
        enabled: true,
        dataClass: "synthetic",
        profiles: [
          {
            version: 1,
            bindingId,
            accountKey: "synthetic",
            harness: "claude_local",
            model: "synthetic-model",
            expectedServedModelId: "synthetic-model",
            effort: "high",
            configurationDigest: "a".repeat(64),
            modelDeployment: "frontier",
            deliveryMode: "static_native",
          },
        ],
        skills: [{ key: "synthetic-skill", versionId }],
        maxConcurrentAttempts: 1,
        maxTurnsPerAttempt: 4,
      },
    };
    return { ...f, body, bindingId, leadAgentId, versionId };
  }

  async function specialistFixture() {
    const f = await configuredFixture();
    const specialistId = randomUUID(), workspaceId = randomUUID();
    await db.insert(agents).values({
      id: specialistId, companyId: f.companyId, name: "Independent reviewer",
      adapterType: "claude_local", status: "paused",
    });
    const [binding] = await db.select().from(executionBindings).where(eq(executionBindings.id, f.bindingId));
    await db.update(executionBindings).set({ definition: {
      ...binding!.definition, allowedAgentIds: [f.leadAgentId, specialistId],
    } }).where(eq(executionBindings.id, f.bindingId));
    await db.insert(projectWorkspaces).values({
      id: workspaceId, companyId: f.companyId, projectId: f.projectId,
      name: "Review workspace", sourceType: "local_path", cwd: process.cwd(),
    });
    const handoff = {
      roleKey: "architecture-reviewer", agentId: specialistId,
      profile: { ...f.body.policy.profiles[0], deliveryMode: "manifest_coordinator" },
      skills: f.body.policy.skills, projectWorkspaceId: workspaceId, maxTurns: 3,
    };
    return { ...f, specialistId, workspaceId, handoff,
      body: { ...f.body, policy: { ...f.body.policy, specialistHandoff: handoff } },
    };
  }

  it("retains one scoped specialist route as intent without activating paused roles", async () => {
    const f = await specialistFixture();
    const saved = await request(f.app()).put(f.url).send(f.body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.policy.specialistHandoff).toEqual(f.handoff);
    expect(saved.body.executionReady).toBe(false);
    expect(saved.body.readinessReasons).toContain("specialist_role_not_active");
    expect((await db.select().from(agents).where(eq(agents.id, f.specialistId)))[0]!.status).toBe("paused");
    await db.update(executionBindings).set({ enabled: false }).where(eq(executionBindings.id, f.bindingId));
    const read = await request(f.app()).get(f.url);
    expect(read.body.readinessReasons).toContain("specialist_binding_not_qualified");
    expect(JSON.stringify(read.body)).not.toContain("private-home");
    const ordinary = await request(f.app()).get(`/api/projects/${f.projectId}`);
    expect(ordinary.body).not.toHaveProperty("coordinationPolicy");
    expect(JSON.stringify(ordinary.body)).not.toContain("architecture-reviewer");
  });

  it("rejects foreign or incompatible specialist role, route, workspace and skill pins", async () => {
    const f = await specialistFixture(), other = await specialistFixture();
    const variants = [
      { ...f.handoff, agentId: other.specialistId },
      { ...f.handoff, agentId: f.leadAgentId },
      { ...f.handoff, profile: other.handoff.profile },
      { ...f.handoff, profile: { ...f.handoff.profile, model: "unapproved" } },
      { ...f.handoff, profile: { ...f.handoff.profile, deliveryMode: "static_native" } },
      { ...f.handoff, projectWorkspaceId: other.workspaceId },
      { ...f.handoff, skills: other.handoff.skills },
    ];
    for (const specialistHandoff of variants) {
      const res = await request(f.app()).put(f.url).send({ ...f.body, policy: { ...f.body.policy, specialistHandoff } });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    await db.update(projectWorkspaces).set({ setupCommand: "must-never-run" }).where(eq(projectWorkspaces.id, f.workspaceId));
    expect((await request(f.app()).put(f.url).send(f.body)).status).toBe(422);
    expect((await request(f.app()).get(f.url)).body.revision).toBe(0);
  });

  it("rejects unbounded specialist policy or caller-supplied permission expansion", async () => {
    const f = await specialistFixture();
    for (const specialistHandoff of [
      { ...f.handoff, maxTurns: 0 }, { ...f.handoff, maxTurns: 101 },
      { ...f.handoff, skills: [...f.handoff.skills, ...f.handoff.skills] },
      { ...f.handoff, roleKey: "not a role" },
      { ...f.handoff, dataClass: "private" },
      { ...f.handoff, permissions: ["write"] },
    ]) {
      expect((await request(f.app()).put(f.url).send({ ...f.body, policy: { ...f.body.policy, specialistHandoff } })).status).toBe(400);
    }
    expect((await request(f.app()).get(f.url)).body.revision).toBe(0);
  });

  it("stores exact scoped pins without enabling delivery or exposing private profiles", async () => {
    const f = await configuredFixture();
    const saved = await request(f.app()).put(f.url).send(f.body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.policy).toEqual(f.body.policy);
    expect(saved.body.executionReady).toBe(false);
    expect(saved.body.readinessReasons).toContain(
      "coordinator_delivery_not_qualified",
    );
    expect(JSON.stringify(saved.body)).not.toContain("private-home");
    expect(JSON.stringify(saved.body)).not.toContain("never-run");
    expect(
      (await db.select().from(agents).where(eq(agents.id, f.leadAgentId)))[0]!
        .status,
    ).toBe("paused");
    const ordinary = await request(f.app()).get(`/api/projects/${f.projectId}`);
    const listed = await request(f.app()).get(
      `/api/companies/${f.companyId}/projects`,
    );
    for (const project of [ordinary.body, ...listed.body]) {
      expect(project).not.toHaveProperty("coordinationPolicy");
      expect(project).not.toHaveProperty("coordinationPolicyRevision");
      expect(project.coordination).toEqual({
        revision: 1,
        configured: true,
        executionReady: false,
        readinessReason: "coordinator_not_qualified",
      });
      expect(JSON.stringify(project)).not.toContain("synthetic-model");
      expect(JSON.stringify(project)).not.toContain("accountKey");
    }
    expect((await request(f.app("agent")).get(f.url)).status).toBe(403);
    await db
      .update(executionBindings)
      .set({ enabled: false })
      .where(eq(executionBindings.id, f.bindingId));
    expect((await request(f.app()).get(f.url)).body.readinessReasons).toContain(
      "binding_not_qualified",
    );
    await expect(
      projectService(db).update(f.projectId, { leadAgentId: null }),
    ).rejects.toThrow("dedicated");
    await expect(
      projectService(db).update(f.projectId, { companyId: randomUUID() }),
    ).rejects.toThrow("dedicated");
  });

  it("preserves ordinary agent routine detail without exposing coordination inventory", async () => {
    const f = await configuredFixture();
    expect((await request(f.app()).put(f.url).send(f.body)).status).toBe(200);
    const [routine] = await db
      .insert(routines)
      .values({
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Synthetic routine",
        description: "Existing detail",
        assigneeAgentId: f.leadAgentId,
        status: "paused",
      })
      .returning();
    const response = await request(f.app("agent")).get(
      `/api/routines/${routine!.id}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.project).not.toHaveProperty("coordinationPolicy");
    expect(response.body).toMatchObject({
      id: routine!.id,
      companyId: f.companyId,
      title: "Synthetic routine",
      description: "Existing detail",
      status: "paused",
      project: {
        id: f.projectId,
        name: "Synthetic project",
        leadAgentId: f.leadAgentId,
        coordination: { revision: 1, configured: true, executionReady: false },
      },
      assignee: { id: f.leadAgentId, name: "Synthetic lead" },
      triggers: [],
      recentRuns: [],
      activeIssue: null,
    });
    expect(response.body.project).not.toHaveProperty(
      "coordinationPolicyRevision",
    );
    expect(JSON.stringify(response.body)).not.toContain("synthetic-model");
    expect(JSON.stringify(response.body)).not.toContain("accountKey");
    expect(JSON.stringify(response.body)).not.toContain("private-home");
  });

  it("rejects wrong company, role, data class, exact model and skill version references", async () => {
    const f = await configuredFixture(),
      other = await configuredFixture();
    const variants = [
      { ...f.body, leadAgentId: other.leadAgentId },
      { ...f.body, policy: { ...f.body.policy, dataClass: "private" } },
      {
        ...f.body,
        policy: { ...f.body.policy, profiles: other.body.policy.profiles },
      },
      {
        ...f.body,
        policy: {
          ...f.body.policy,
          profiles: [{ ...f.body.policy.profiles[0], model: "different" }],
        },
      },
      {
        ...f.body,
        policy: { ...f.body.policy, skills: other.body.policy.skills },
      },
    ];
    for (const body of variants)
      expect((await request(f.app()).put(f.url).send(body)).status).toBe(422);
    expect((await request(f.app()).get(f.url)).body.revision).toBe(0);
    const unknownMode = {
      ...f.body,
      policy: {
        ...f.body.policy,
        profiles: [
          {
            ...f.body.policy.profiles[0],
            deliveryMode: "unsupported_coordinator_mode",
          },
        ],
      },
    };
    expect((await request(f.app()).put(f.url).send(unknownMode)).status).toBe(
      400,
    );
    const supportedMode = {
      ...f.body,
      policy: {
        ...f.body.policy,
        profiles: [
          {
            ...f.body.policy.profiles[0],
            deliveryMode: "manifest_coordinator",
          },
        ],
      },
    };
    const stored = await request(f.app()).put(f.url).send(supportedMode);
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ revision: 1, executionReady: false });
    expect((await request(f.app()).get(f.url)).body.executionReady).toBe(false);
  });

  it("serializes a generic role change against board policy ownership", async () => {
    const f = await configuredFixture();
    const results = await Promise.allSettled([
      request(f.app())
        .put(f.url)
        .send(f.body)
        .then((r) => {
          expect(r.status).toBe(200);
        }),
      projectService(db).update(f.projectId, { leadAgentId: null }),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    const read = await request(f.app()).get(f.url);
    expect(read.body.leadAgentId).toBe(f.leadAgentId);
    expect(read.body.revision).toBe(1);
  });

  it("persists with revision CAS, native audit, and explicitly unavailable execution", async () => {
    const f = await fixture();
    const body = { expectedRevision: 0, leadAgentId: null, policy: null };
    const results = await Promise.all([
      request(f.app()).put(f.url).send(body),
      request(f.app()).put(f.url).send(body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const read = await request(f.app()).get(f.url);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      revision: 1,
      policy: null,
      executionReady: false,
      readinessReasons: ["policy_not_configured"],
    });
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, f.projectId));
    expect(
      logs.filter((r) => r.action === "project.coordination_policy_updated"),
    ).toHaveLength(1);
  });

  it("denies agent, viewer and foreign-company writes while retaining read access", async () => {
    const f = await fixture();
    const body = { expectedRevision: 0, leadAgentId: null, policy: null };
    expect((await request(f.app("agent")).put(f.url).send(body)).status).toBe(
      403,
    );
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.companyId, f.companyId));
    expect((await request(f.app("viewer")).put(f.url).send(body)).status).toBe(
      403,
    );
    expect((await request(f.app("viewer")).get(f.url)).status).toBe(200);
    const other = await fixture();
    expect((await request(other.app()).put(f.url).send(body)).status).toBe(404);
  });

  it("rejects generic policy injection at both API and service boundaries", async () => {
    const f = await fixture();
    expect(
      (
        await request(f.app("agent"))
          .patch(`/api/projects/${f.projectId}`)
          .send({ coordinationPolicy: null })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app())
          .post(`/api/companies/${f.companyId}/projects`)
          .send({ name: "Injected", coordinationPolicyRevision: 4 })
      ).status,
    ).toBe(400);
    await expect(
      projectService(db).update(f.projectId, {
        coordinationPolicy: null,
      } as never),
    ).rejects.toThrow("dedicated");
    await expect(
      projectService(db).create(f.companyId, {
        name: "Injected",
        coordinationPolicyRevision: 4,
      } as never),
    ).rejects.toThrow("dedicated");
  });

  it("retains read access but rejects policy writes on archived projects", async () => {
    const f = await fixture();
    await db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, f.projectId));
    expect((await request(f.app()).get(f.url)).body.readinessReasons).toContain(
      "project_archived",
    );
    expect(
      (
        await request(f.app())
          .put(f.url)
          .send({ expectedRevision: 0, leadAgentId: null, policy: null })
      ).status,
    ).toBe(409);
  });
});

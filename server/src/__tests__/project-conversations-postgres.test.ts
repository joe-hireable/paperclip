import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { issueService } from "../services/issues.js";

describe("project conversations PostgreSQL persistence", () => {
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
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: "Synthetic",
        issuePrefix: `T${companyId.slice(0, 6)}`,
        defaultResponsibleUserId: "board-user",
      });
    await db
      .insert(companyMemberships)
      .values({
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
      app.use(errorHandler);
      return app;
    };
    const url = `/api/projects/${projectId}/conversation`;
    return { companyId, projectId, app, url };
  }

  it("serializes concurrent ensure and retains the same master after completion", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(f.app()).post(f.url).send({})),
    );
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    const ids = new Set(results.map((r) => r.body.masterIssue.id));
    expect(ids.size).toBe(1);
    const id = results[0]!.body.masterIssue.id;
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, id));
    const again = await request(f.app()).post(f.url).send({});
    expect(again.body.masterIssue.id).toBe(id);
    expect(again.body.executionReady).toBe(false);
    expect(
      await db.select().from(activityLog).where(eq(activityLog.entityId, id)),
    ).toHaveLength(1);
  });

  it("adopts only explicitly selected manual roots without changing content or ownership", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db
      .insert(issues)
      .values({
        id,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Existing conversation",
        description: "Keep every note",
        assigneeUserId: "board-user",
        createdByUserId: "original-author",
        responsibleUserId: "original-owner",
      });
    await db
      .insert(issueComments)
      .values({
        companyId: f.companyId,
        issueId: id,
        authorUserId: "original-author",
        body: "Historical note",
      });
    const response = await request(f.app())
      .post(f.url)
      .send({ adoptIssueId: id });
    expect(response.status).toBe(200);
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: id })).body
        .masterIssue.id,
    ).toBe(id);
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    expect(row).toMatchObject({
      title: "Existing conversation",
      description: "Keep every note",
      assigneeUserId: "board-user",
      createdByUserId: "original-author",
      responsibleUserId: "original-owner",
      originKind: "project_master_chat",
      originId: f.projectId,
    });
    expect(
      (
        await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, id))
      )[0]?.body,
    ).toBe("Historical note");
  });

  it("enforces permanent origin uniqueness even for terminal hidden issues", async () => {
    const f = await fixture();
    const master = {
      companyId: f.companyId,
      projectId: f.projectId,
      title: "Record",
      originKind: "project_master_chat",
      originId: f.projectId,
      status: "done",
      hiddenAt: new Date(),
    };
    await db.insert(issues).values(master);
    await expect(
      db
        .insert(issues)
        .values({ ...master, status: "backlog", hiddenAt: null }),
    ).rejects.toThrow();
  });

  it("refuses generic master moves, identity changes, assignment and checkout", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db
      .insert(issues)
      .values({
        id,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Master",
        originKind: "project_master_chat",
        originId: f.projectId,
      });
    for (const patch of [
      { parentId: randomUUID() },
      { projectId: null },
      { originKind: "manual" },
      { originId: randomUUID() },
      { assigneeAgentId: randomUUID() },
    ]) {
      await expect(issueService(db).update(id, patch)).rejects.toThrow();
    }
    await expect(
      issueService(db).checkout(id, randomUUID(), ["backlog"], null),
    ).rejects.toThrow(/conversation/i);
    expect(
      await issueService(db).update(id, { title: "Renamed conversation" }),
    ).toMatchObject({ title: "Renamed conversation" });
  });

  it("keeps archived masters readable but refuses ensure writes", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db
      .insert(issues)
      .values({
        id,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Master",
        originKind: "project_master_chat",
        originId: f.projectId,
      });
    await db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, f.projectId));
    expect((await request(f.app()).get(f.url)).body).toMatchObject({
      masterIssue: { id },
      executionReady: false,
      readinessReason: "project_archived",
    });
    expect((await request(f.app()).post(f.url).send({})).status).toBe(409);
  });

  it("refuses agents, viewer writes, cross-company reads and ambiguous adoption", async () => {
    const f = await fixture(),
      other = await fixture();
    expect((await request(f.app("agent")).post(f.url).send({})).status).toBe(
      403,
    );
    expect((await request(f.app("viewer")).post(f.url).send({})).status).toBe(
      403,
    );
    expect((await request(other.app()).get(f.url)).status).toBe(404);
    const wrong = randomUUID();
    await db
      .insert(issues)
      .values({
        id: wrong,
        companyId: other.companyId,
        projectId: other.projectId,
        title: "Wrong scope",
      });
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: wrong })).status,
    ).toBe(422);
    const created = await request(f.app()).post(f.url).send({});
    expect(created.status).toBe(200);
    const alternative = randomUUID();
    await db
      .insert(issues)
      .values({
        id: alternative,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Alternative",
      });
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: alternative }))
        .status,
    ).toBe(409);
  });
  it("rejects non-root, non-manual, assigned and locked adoption candidates", async () => {
    const f = await fixture();
    const agentId = randomUUID();
    await db
      .insert(agents)
      .values({
        id: agentId,
        companyId: f.companyId,
        name: "Never executed",
        status: "paused",
      });
    const runId = randomUUID();
    await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId: f.companyId,
        agentId,
        status: "running",
      });
    const parentId = randomUUID();
    await db
      .insert(issues)
      .values({
        id: parentId,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Parent",
      });
    for (const extra of [
      { parentId },
      { originKind: "routine" },
      { assigneeAgentId: agentId },
      { checkoutRunId: runId },
      { executionRunId: runId },
      { executionLockedAt: new Date() },
    ]) {
      const id = randomUUID();
      await db
        .insert(issues)
        .values({
          id,
          companyId: f.companyId,
          projectId: f.projectId,
          title: "Ineligible",
          ...extra,
        });
      expect(
        (await request(f.app()).post(f.url).send({ adoptIssueId: id })).status,
      ).toBe(422);
    }
  });

  it("refuses pending work and terminal runs with held leases, then permits settled adoption", async () => {
    const f = await fixture();
    const id = randomUUID(),
      agentId = randomUUID(),
      runId = randomUUID(),
      bindingId = randomUUID();
    await db
      .insert(agents)
      .values({
        id: agentId,
        companyId: f.companyId,
        name: "Never executed",
        status: "paused",
      });
    await db
      .insert(issues)
      .values({
        id,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Pending",
      });
    const [wake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: f.companyId,
        agentId,
        source: "on_demand",
        payload: { issueId: id },
      })
      .returning();
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: id })).status,
    ).toBe(409);
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed" })
      .where(eq(agentWakeupRequests.id, wake!.id));
    await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId: f.companyId,
        agentId,
        contextSnapshot: { issueId: id },
        status: "queued",
      });
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: id })).status,
    ).toBe(409);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, runId));
    // Synthetic persistence fixtures only: no provider profile is created or consumed.
    await db.execute(
      sql`insert into execution_bindings (id, company_id, definition) values (${bindingId}, ${f.companyId}, '{}'::jsonb)`,
    );
    await db.execute(
      sql`insert into run_execution_bindings (run_id, company_id, binding_id, account_key, snapshot, owner_id) values (${runId}, ${f.companyId}, ${bindingId}, ${randomUUID()}, '{}'::jsonb, 'fixture')`,
    );
    expect(
      (await request(f.app()).post(f.url).send({ adoptIssueId: id })).status,
    ).toBe(409);
    await db.execute(
      sql`update run_execution_bindings set released_at = now() where run_id = ${runId}`,
    );
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(f.app()).post(f.url).send({ adoptIssueId: id }),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body.masterIssue.id).toBe(id);
    }
  });

  it("does not delete the permanent master or forge one with generic update", async () => {
    const f = await fixture();
    const id = randomUUID();
    await db
      .insert(issues)
      .values({
        id,
        companyId: f.companyId,
        projectId: f.projectId,
        title: "Manual",
      });
    await expect(
      issueService(db).update(id, {
        originKind: "project_master_chat",
        originId: f.projectId,
      }),
    ).rejects.toThrow(/conversation/i);
    await request(f.app()).post(f.url).send({ adoptIssueId: id });
    await expect(issueService(db).remove(id)).rejects.toThrow(/conversation/i);
    expect((await request(f.app()).get(f.url)).body.masterIssue.id).toBe(id);
  });
});

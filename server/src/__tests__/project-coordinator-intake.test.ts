import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, and, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  projects,
  issues,
  issueComments,
  issueDocuments,
  documents,
  heartbeatRuns,
  agentWakeupRequests,
  runExecutionBindings,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { projectConversationService } from "../services/project-conversations.js";
import { documentService } from "../services/documents.js";

describe("durable coordinator intake PostgreSQL/API", () => {
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
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    };
    const master = (
      await projectConversationService(db).ensure(
        companyId,
        projectId,
        "board-user",
      )
    ).masterIssue!;
    return { companyId, projectId, app, master };
  }

  it("atomically deduplicates both comment paths and preserves blocked source after recreation", async () => {
    const f = await fixture(),
      intakeRequestId = randomUUID();
    const post = () =>
      request(f.app())
        .post(`/api/issues/${f.master.id}/comments`)
        .send({ body: "Rough thought", reopen: false, intakeRequestId });
    const patch = () =>
      request(f.app())
        .patch(`/api/issues/${f.master.id}`)
        .send({ comment: "Rough thought", intakeRequestId });
    const responses = await Promise.all([post(), patch(), post()]);
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, f.master.id));
    expect(comments).toHaveLength(1);
    const children = await db
      .select()
      .from(issues)
      .where(eq(issues.parentId, f.master.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      status: "blocked",
      assigneeAgentId: null,
      executionRunId: null,
      originKind: "project_coordinator_intake",
      originFingerprint: intakeRequestId,
    });
    const source = await documentService(db).getIssueDocumentByKey(
      children[0]!.id,
      "coordinator-intake-source",
    );
    expect(JSON.parse(source!.body!)).toMatchObject({
      sourceCommentId: comments[0]!.id,
      masterIssueId: f.master.id,
      qualification: "coordinator_not_qualified",
    });
    expect((await post()).status).toBeLessThan(300);
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, f.companyId));
    expect(
      activities.filter((event) => event.action === "issue.comment_added"),
    ).toMatchObject([
      {
        entityId: f.master.id,
        actorId: "board-user",
        details: { commentId: comments[0]!.id },
      },
    ]);
    expect(
      activities.filter(
        (event) =>
          event.action === "issue.created" &&
          event.entityId === children[0]!.id,
      ),
    ).toHaveLength(1);
    expect(
      activities.filter(
        (event) => event.action === "project.coordinator_intake_created",
      ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId)),
    ).toHaveLength(0);
    expect(
      (
        await request(f.app())
          .post(`/api/issues/${f.master.id}/comments`)
          .send({ body: "Different", intakeRequestId })
      ).status,
    ).toBe(409);
  });

  it("rejects foreign, forged-agent and archived intake without partial writes", async () => {
    const f = await fixture(),
      other = await fixture();
    const body = { body: "Thought", intakeRequestId: randomUUID() };
    expect(
      (
        await request(other.app())
          .post(`/api/issues/${f.master.id}/comments`)
          .send(body)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(f.app("agent"))
          .post(`/api/issues/${f.master.id}/comments`)
          .send(body)
      ).status,
    ).toBe(403);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.companyId, f.companyId));
    expect(
      (
        await request(f.app("viewer"))
          .post(`/api/issues/${f.master.id}/comments`)
          .send(body)
      ).status,
    ).toBe(403);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "admin" })
      .where(eq(companyMemberships.companyId, f.companyId));
    await db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, f.projectId));
    expect(
      (
        await request(f.app())
          .post(`/api/issues/${f.master.id}/comments`)
          .send(body)
      ).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, f.master.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(issues).where(eq(issues.parentId, f.master.id)),
    ).toHaveLength(0);
  });
  it("keeps source authority immutable and intake non-executable through generic mutations", async () => {
    const f = await fixture();
    const response = await request(f.app())
      .post(`/api/issues/${f.master.id}/comments`)
      .send({ body: "Keep source", intakeRequestId: randomUUID() });
    expect(response.status).toBe(201);
    const child = response.body.coordinatorIntake;
    const source = await documentService(db).getIssueDocumentByKey(
      child.id,
      "coordinator-intake-source",
    );
    expect(
      (
        await request(f.app())
          .put(`/api/issues/${child.id}/documents/coordinator-intake-source`)
          .send({
            title: "Forged",
            body: "Forged",
            format: "markdown",
            baseRevisionId: source!.latestRevisionId,
          })
      ).status,
    ).toBe(409);
    await expect(
      documentService(db).unlockIssueDocument(
        child.id,
        "coordinator-intake-source",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      documentService(db).deleteIssueDocument(
        child.id,
        "coordinator-intake-source",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      documentService(db).restoreIssueDocumentRevision({
        issueId: child.id,
        key: "coordinator-intake-source",
        revisionId: source!.latestRevisionId!,
      }),
    ).rejects.toThrow("immutable");
    await expect(
      issueService(db).update(child.id, { status: "todo" }),
    ).rejects.toThrow("qualification");
    await expect(
      issueService(db).update(child.id, { originKind: "manual" }),
    ).rejects.toThrow("qualification");
    await expect(
      issueService(db).update(f.master.id, {
        originKind: "project_coordinator_intake",
      }),
    ).rejects.toThrow();
    expect(
      (await documentService(db).getIssueDocumentByKey(
        child.id,
        "coordinator-intake-source",
      ))!.body,
    ).toBe(source!.body);
  });

  it("rolls back the comment and child when source persistence fails", async () => {
    const f = await fixture();
    await db.execute(
      sql`create function reject_intake_source() returns trigger language plpgsql as $$ begin if NEW.title = 'Coordinator intake source' then raise exception 'synthetic persistence failure'; end if; return NEW; end $$`,
    );
    await db.execute(
      sql`create trigger reject_intake_source before insert on documents for each row execute function reject_intake_source()`,
    );
    try {
      const response = await request(f.app())
        .post(`/api/issues/${f.master.id}/comments`)
        .send({ body: "Atomic input", intakeRequestId: randomUUID() });
      expect(response.status).toBe(500);
      expect(
        await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, f.master.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(issues).where(eq(issues.parentId, f.master.id)),
      ).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger reject_intake_source on documents`);
      await db.execute(sql`drop function reject_intake_source()`);
    }
  });

  it("suppresses direct intake wake and queued recovery without any adapter call or held lease", async () => {
    const f = await fixture(),
      agentId = randomUUID(),
      adapterType = "synthetic-intake-guard";
    const response = await request(f.app())
      .post(`/api/issues/${f.master.id}/comments`)
      .send({ body: "Stay blocked", intakeRequestId: randomUUID() });
    const child = response.body.coordinatorIntake;
    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
    }));
    registerServerAdapter({
      type: adapterType,
      execute,
      testEnvironment: async () => ({
        adapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    const heartbeat = heartbeatService(db);
    try {
      await db.insert(agents).values({
        id: agentId,
        companyId: f.companyId,
        name: "No provider",
        adapterType,
        status: "idle",
        adapterConfig: { cwd: "/tmp" },
      });
      expect(
        await heartbeat.wakeup(agentId, {
          source: "on_demand",
          contextSnapshot: { issueId: child.id },
          requestedByActorType: "user",
          requestedByActorId: "board-user",
        }),
      ).toBeNull();
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId,
        status: "queued",
        invocationSource: "on_demand",
        nativeIssueId: child.id,
        contextSnapshot: { issueId: child.id },
      });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId));
      expect(runs).toEqual([expect.objectContaining({ status: "cancelled" })]);
      expect(
        await db
          .select()
          .from(runExecutionBindings)
          .where(
            and(
              eq(runExecutionBindings.companyId, f.companyId),
              sql`${runExecutionBindings.releasedAt} is null`,
            ),
          ),
      ).toHaveLength(0);
      expect((await issueService(db).getById(child.id))!).toMatchObject({
        status: "blocked",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    }
  });
  it("rejects mixed master mutation and forged source metadata before any comment persists", async () => {
    const f = await fixture();
    expect(
      (
        await request(f.app()).patch(`/api/issues/${f.master.id}`).send({
          comment: "Thought",
          title: "Changed",
          intakeRequestId: randomUUID(),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(f.app())
          .post(`/api/issues/${f.master.id}/comments`)
          .send({
            body: "Thought",
            intakeRequestId: randomUUID(),
            metadata: {
              version: 1,
              sections: [
                { rows: [{ type: "text", text: "Pretend source authority" }] },
              ],
            },
          })
      ).status,
    ).toBe(422);
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, f.master.id)),
    ).toHaveLength(0);
    expect((await issueService(db).getById(f.master.id))!.title).toBe(
      f.master.title,
    );
  });
});

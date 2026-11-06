import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { intelligentRoutingContracts } from "@paperclipai/db/schema/intelligent_routing";
import {
  agents,
  agentApiKeys,
  authUsers,
  companies,
  companyMemberships,
  projects,
  goals,
  projectGoals,
  projectWorkspaces,
  executionWorkspaces,
  companySkills,
  companySkillVersions,
  executionBindings,
  plugins,
  pluginDatabaseNamespaces,
  issues,
  issueComments,
  heartbeatRuns,
  runExecutionBindings,
  agentWakeupRequests,
  issueDocuments,
  documents,
  documentRevisions,
  activityLog,
  createDb,
} from "@paperclipai/db";
import {
  applyCommand,
  emptyState,
} from "../../../packages/plugins/plugin-shared-operations/src/domain.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { projectConversationService } from "../services/project-conversations.js";
import { projectCoordinatorIntakeService } from "../services/project-coordinator-intake.js";
import {
  intelligentRoutingContractService,
  routingConfigurationDigest,
  type IntelligentRoutingContractInput,
} from "../services/intelligent-routing-contracts.js";
import { intelligentRoutingDigest as digest } from "../services/intelligent-routing-policy.js";
import {
  resolveExecutionBindingSnapshot,
  executionBindingService,
} from "../services/execution-bindings.js";
import { collectIntelligentRoutingRuntimeFingerprint } from "../services/intelligent-routing-runtime.js";
import {
  assertCoordinatorRunAdmission,
  loadCoordinatorAuthorityForDispatch,
  projectCoordinatorAttemptService,
} from "../services/project-coordinator-attempts.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { intelligentRoutingRoutes } from "../routes/intelligent-routing.js";
import { issueRoutes } from "../routes/issues.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter } from "../adapters/index.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { AuthorizationActor } from "../services/authorization.js";

describe("finite coordinator authority PostgreSQL/API — no provider", () => {
  let db: ReturnType<typeof createDb>,
    temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let profileRoot: string;
  const namespace = "plugin_coordinator_test";
  beforeAll(async () => {
    profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "coordinator-native-fixtures-"),
    );
    vi.stubEnv("PAPERCLIP_HOME", profileRoot);
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:1");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-coordinator-only-key");
    temp = await startEmbeddedPostgresTestDatabase(
      "paperclip-coordinator-attempt-",
    );
    db = createDb(temp.connectionString);
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
    });
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-shared-operations",
      packageName: "synthetic",
      version: "0.1.0",
      status: "ready",
      manifestJson: {} as never,
    });
    await db.insert(pluginDatabaseNamespaces).values({
      pluginId,
      pluginKey: "paperclipai.plugin-shared-operations",
      namespaceName: namespace,
    });
    await db.execute(
      sql.raw(
        `CREATE SCHEMA ${namespace}; CREATE TABLE ${namespace}.company_state(company_id uuid PRIMARY KEY, revision integer NOT NULL DEFAULT 1, document jsonb NOT NULL)`,
      ),
    );
  }, 30_000);
  afterEach(async () => {
    // Cases share only this disposable DB; leave no unrelated pending intent
    // for a later test of the real global restart hook.
    await db
      .update(issues)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(issues.originKind, "project_coordinator_attempt"),
          eq(issues.status, "todo"),
        ),
      );
  });
  afterAll(async () => {
    await temp?.cleanup();
    if (profileRoot) {
      async function writable(dir: string) {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      }
      await writable(profileRoot);
      await fs.rm(profileRoot, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  async function fixture(qualified = false, withContext = false) {
    const dataClass = withContext ? "private" as const : "synthetic" as const;
    const companyId = randomUUID(),
      projectId = randomUUID(),
      leadId = randomUUID(),
      skillId = randomUUID(),
      versionId = randomUUID(),
      bindingId = randomUUID(),
      userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic",
      issuePrefix: `Q${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Synthetic",
      email: `${userId}@example.invalid`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      membershipRole: "admin",
      status: "active",
    });
    await db.insert(agents).values({
      id: leadId,
      companyId,
      name: "Synthetic lead",
      adapterType: "claude_local",
      status: "idle",
    });
    const cwd = path.join(profileRoot, companyId);
    await fs.mkdir(cwd, { recursive: true });
    if (qualified) {
      await fs.mkdir(cwd, { recursive: true });
      execFileSync("git", ["init", "--quiet", cwd]);
      await fs.mkdir(path.join(cwd, "profile"));
      await fs.writeFile(
        path.join(cwd, "claude"),
        `#!${process.execPath}
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"11111111-1111-4111-8111-111111111111",model:"synthetic-model"}));
console.log(JSON.stringify({type:"result",result:"synthetic complete",usage:{input_tokens:1,output_tokens:1}}));
`,
        { mode: 0o755 },
      );
      await fs.writeFile(path.join(cwd, "ROLE.md"), "Synthetic qualified role");
      await db
        .update(agents)
        .set({
          adapterConfig: {
            cwd,
            engine: "cli",
            instructionsFilePath: path.join(cwd, "ROLE.md"),
            maxTurnsPerRun: 2,
            timeoutSec: 30,
          },
        })
        .where(eq(agents.id, leadId));
    }
    const definition = {
      name: "Synthetic",
      accountKey: `synthetic-${companyId}`,
      adapterType: "claude_local" as const,
      command: qualified ? path.join(cwd, "claude") : "/synthetic/never-run",
      nativeProfileHome: qualified
        ? path.join(cwd, "profile")
        : "/synthetic/private-home",
      models: ["synthetic-model"],
      ...(qualified ? { runtimeFilePaths: [path.join(cwd, "claude")] } : {}),
      reasoningEffort: "high" as const,
      capabilities: ["text"],
      dataClasses: [dataClass],
      allowedAgentIds: [leadId],
      billingRoute: "native_subscription" as const,
      evidenceRefs: ["synthetic-only"],
      verifiedUntil: "2099-01-01T00:00:00.000Z",
    };
    await db.insert(executionBindings).values({
      id: bindingId,
      companyId,
      enabled: true,
      profileRoots: [definition.nativeProfileHome],
      definition,
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "synthetic-skill",
      slug: "synthetic-skill",
      name: "Synthetic",
      markdown: "Synthetic",
    });
    await db.insert(companySkillVersions).values({
      id: versionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 1,
      fileInventory: [
        {
          path: "SKILL.md",
          kind: "skill",
          content: "selected reference marker",
        },
      ] as never,
    });
    let configurationDigest = "a".repeat(64);
    if (qualified) {
      const [lead] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, leadId));
      const [row] = await db
        .select()
        .from(executionBindings)
        .where(eq(executionBindings.id, bindingId));
      const binding = {
        ...definition,
        id: bindingId,
        companyId,
        enabled: true,
        createdAt: row!.createdAt,
      };
      const snapshot = resolveExecutionBindingSnapshot({
        binding,
        agent: lead!,
        selection: {
          bindingId,
          model: definition.models[0]!,
          dataClass,
          requiredCapabilities: ["text"],
          evidenceRefs: ["synthetic-only"],
          reason: "Fixture",
        },
        taskKey: "fixture",
        deliveryMode: "manifest_coordinator",
      });
      configurationDigest = routingConfigurationDigest(
        snapshot.adapterConfig,
        lead!.permissions,
        await collectIntelligentRoutingRuntimeFingerprint({
          binding,
          adapterConfig: snapshot.adapterConfig,
          runtimeFilePaths: definition.runtimeFilePaths,
        }),
      );
    }
    const policy = {
      version: 1 as const,
      enabled: true,
      dataClass,
      profiles: [
        {
          version: 1 as const,
          bindingId,
          accountKey: definition.accountKey,
          harness: "claude_local",
          model: "synthetic-model",
          expectedServedModelId: "synthetic-model",
          effort: "high" as const,
          configurationDigest,
          modelDeployment: "frontier" as const,
          deliveryMode: qualified
            ? ("manifest_coordinator" as const)
            : ("static_native" as const),
        },
      ],
      skills: [{ key: "synthetic-skill", versionId }],
      maxConcurrentAttempts: 1,
      maxTurnsPerAttempt: 2,
    };
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Synthetic",
      leadAgentId: leadId,
      coordinationPolicyRevision: 1,
      coordinationPolicy: policy,
    });
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId, name: "Synthetic local", cwd })
      .returning();
    const state = applyCommand(
      emptyState(),
      {
        type: "policy.publish",
        id: "synthetic-central",
        bundle: {
          instructions: ["approved instruction"],
          constraints: ["No providers"],
          skills: [],
          hooks: [],
        },
        reason: "Synthetic only",
      },
      { kind: "board", id: userId },
      new Date().toISOString(),
    );
    state.memories.push({
      id: "private",
      content: "DO NOT PROJECT PRIVATE MEMORY",
    } as never);
    await db.execute(
      sql`INSERT INTO ${sql.identifier(namespace)}.company_state(company_id, document) VALUES (${companyId}, ${JSON.stringify(state)}::jsonb)`,
    );
    const actor: AuthorizationActor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    };
    const master = (
      await projectConversationService(db).ensure(companyId, projectId, userId)
    ).masterIssue!;
    const intakeResult = await projectCoordinatorIntakeService(db).addComment({
      masterId: master.id,
      body: "Synthetic rough thought",
      requestId: randomUUID(),
      actor,
      sourceTrust: {
        preset: "standard",
        disposition: "promoted",
        sourceIssueId: master.id,
      },
    });
    const input = {
      projectWorkspaceId: workspace!.id,
      expectedPolicyRevision: 1,
      centralCompanyId: companyId,
      expectedCentralPolicyDigest: state.policies[0]!.digest,
      ...(withContext ? { projectContext: {} } : {}),
    };
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use((req, _res, next) => {
      if (!req.headers.authorization) {
        req.actor = actor as never;
        next();
      } else
        actorMiddleware(db, {
          deploymentMode: "authenticated",
          resolveSession: async () => null,
        })(req, _res, next);
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(
      "/api",
      intelligentRoutingRoutes(db, {
        resolveSnapshot: resolveExecutionBindingSnapshot,
      }),
    );
    let escaped = 0;
    app.all("/{*rest}", (_req, res) => {
      escaped++;
      res.json({ escaped: true });
    });
    app.use(errorHandler);
    const prepare = () =>
      request(app)
        .post(`/api/issues/${intakeResult.intake.id}/coordinator-attempt`)
        .send(input);
    return {
      companyId,
      projectId,
      cwd,
      policy,
      leadId,
      bindingId,
      definition,
      skillId,
      versionId,
      userId,
      actor,
      master,
      intake: intakeResult.intake,
      comment: intakeResult.comment,
      input,
      app,
      prepare,
      escaped: () => escaped,
    };
  }


  it("project context snapshots current master revisions and project-linked goals idempotently", async () => {
    const f = await fixture(true, true);
    const old = await documentService(db).upsertIssueDocument({ issueId:f.master.id,key:"current-work",format:"markdown",body:"Superseded direction",createdByUserId:f.userId });
    const current = await documentService(db).upsertIssueDocument({ issueId:f.master.id,key:"current-work",format:"markdown",body:"Constraint: keep the blue gate closed",baseRevisionId:old.document.latestRevisionId,createdByUserId:f.userId });
    await db.insert(goals).values({companyId:f.companyId,title:"Unlinked company goal must not be projected"});
    const [goal] = await db.insert(goals).values({companyId:f.companyId,title:"Scoped operating goal",description:"Retain native evidence"}).returning();
    await db.insert(projectGoals).values({companyId:f.companyId,projectId:f.projectId,goalId:goal!.id});
    const first=await f.prepare();
    expect(first.status,JSON.stringify(first.body)).toBe(200);
    const saved=await documentService(db).getIssueDocumentByKey(first.body.attemptId,"coordinator-attempt-authority");
    const context=JSON.parse(saved!.body!).projectContext;
    expect(context.documents.find((d:{key:string})=>d.key==="current-work")).toMatchObject({revisionId:current.document.latestRevisionId,body:"Constraint: keep the blue gate closed"});
    expect(context.documents.find((d:{key:string})=>d.key==="requirements-register")).toEqual({key:"requirements-register",present:false});
    expect(context.goals).toEqual([expect.objectContaining({id:goal!.id,title:"Scoped operating goal"})]);
    expect(JSON.stringify(context)).not.toContain("Superseded direction");
    expect((await f.prepare()).body.authorityDigest).toBe(first.body.authorityDigest);
  });


  it("project context refuses synthetic history and forged source selectors", async () => {
    const f=await fixture(true);
    for (const selection of [{},{documentKeys:["current-work"]}]) {
      const r=await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:selection});
      expect(r.status).toBe(403);
    }
    const r=await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:{body:"pretend public",companyId:f.companyId}});
    expect(r.status).toBe(400);
  });

  for (const change of ["document", "absent-document", "linked-goal", "old-board-edit", "new-board", "membership", "execution-role"] as const) {
    it(`project context refuses ${change} drift through own-task GET/PUT and dispatch`,async()=>{
      const base=await fixture(true,true);
      const doc=await documentService(db).upsertIssueDocument({issueId:base.master.id,key:"current-work",format:"markdown",body:"Current requirement",createdByUserId:base.userId});
      const [older]=await db.insert(issueComments).values({companyId:base.companyId,issueId:base.master.id,body:"Earlier instruction",authorUserId:base.userId,authorType:"user",createdAt:new Date(0)}).returning();
      const f=await activeFixture(base);
      expect((await f.context()).status).toBe(200);
      if(change==="document") await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"current-work",format:"markdown",body:"New requirement",createdByUserId:f.userId,baseRevisionId:doc.document.latestRevisionId});
      if(change==="absent-document") await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"operating-goal",format:"markdown",body:"New goal",createdByUserId:f.userId});
      if(change==="linked-goal") {
        const [g]=await db.insert(goals).values({companyId:f.companyId,title:"New link"}).returning();
        await db.insert(projectGoals).values({companyId:f.companyId,projectId:f.projectId,goalId:g!.id});
      }
      if(change==="old-board-edit") await db.update(issueComments).set({body:"Updated earlier instruction"}).where(eq(issueComments.id,older!.id));
      if(change==="new-board") await db.insert(issueComments).values({companyId:f.companyId,issueId:f.master.id,body:"Stop, requirements changed",authorUserId:f.userId,authorType:"user"});
      if(change==="membership") await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.companyId),eq(companyMemberships.principalId,f.userId)));
      if(change==="execution-role") await db.update(agents).set({status:"terminated"}).where(eq(agents.id,f.leadId));
      expect(change === "execution-role" ? [401] : [403,409]).toContain((await f.context()).status);
      const put=await request(f.app).put(`/api/issues/${f.attemptId}/coordinator-result`).set("Authorization",`Bearer ${f.token}`).send({body:"Stale output"});
      expect(change === "execution-role" ? [401] : [403,409]).toContain(put.status);
      await expect(db.transaction(tx=>loadCoordinatorAuthorityForDispatch(tx as unknown as typeof db,f.companyId,f.attemptId))).rejects.toThrow();
      expect(await documentService(db).getIssueDocumentByKey(f.attemptId,"coordinator-result")).toBeNull();
    });
  }

  it("project context confines prior comment IDs to canonical master and retains only current revisions",async()=>{
    const f=await fixture(true,true), foreign=await fixture(true,true);
    for(const commentId of [foreign.comment.id,randomUUID(),f.comment.id]) {
      const r=await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:{commentIds:[commentId]}});
      expect(r.status).toBe(409);
    }
    const [prior]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.master.id,body:"Prior native constraint",authorUserId:f.userId,authorType:"user",createdAt:new Date(0)}).returning();
    const prepared=await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:{commentIds:[prior!.id]}});
    expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);
    const saved=await documentService(db).getIssueDocumentByKey(prepared.body.attemptId,"coordinator-attempt-authority");
    expect(JSON.parse(saved!.body!).projectContext.comments).toEqual([expect.objectContaining({id:prior!.id,body:"Prior native constraint",createdByUserId:f.userId})]);
    await db.update(issueComments).set({deletedAt:new Date()}).where(eq(issueComments.id,prior!.id));
    await expect(db.transaction(tx=>loadCoordinatorAuthorityForDispatch(tx as unknown as typeof db,f.companyId,prepared.body.attemptId))).rejects.toThrow(/context/i);
  });

  it("project context ignores native system notices and inherits exact snapshot into specialist",async()=>{
    const f=await specialistFixture(true);
    const before=await f.context();
    expect(before.status,JSON.stringify(before.body)).toBe(200);
    await issueService(db).addComment(f.master.id,"Native progress",{runId:f.runId},{authorType:"system",presentation:{kind:"system_notice",title:"Progress",tone:"info",detailsDefaultOpen:true}});
    expect((await f.context()).body.projectContext).toEqual(before.body.projectContext);
    expect((await f.put({body:"Parent finding",handoff:f.handoff})).status).toBe(200);
    expect(await f.finish()).toEqual({status:"in_review"});
    const [child]=await f.children();
    expect(child).toBeDefined();
    const saved=await documentService(db).getIssueDocumentByKey(child!.id,"coordinator-attempt-authority");
    expect(JSON.parse(saved!.body!).projectContext).toEqual(before.body.projectContext);
    const state=await db.transaction(tx=>loadCoordinatorAuthorityForDispatch(tx as unknown as typeof db,f.companyId,child!.id));
    expect(state.projectContext).toEqual(before.body.projectContext);
  });

  it("project context drift after parent result preserves settlement and prevents specialist creation",async()=>{
    const f=await specialistFixture(true);
    expect((await f.put({body:"Parent finding",handoff:f.handoff})).status).toBe(200);
    await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"requirements-register",format:"markdown",body:"New constraint",createdByUserId:f.userId});
    expect(await f.finish()).toEqual({status:"in_review"});
    expect(await f.children()).toHaveLength(0);
    expect(await projectCoordinatorAttemptService(db).settle(f.attemptId,f.runId)).toEqual({status:"in_review"});
    const [lease]=await db.select().from(runExecutionBindings).where(eq(runExecutionBindings.runId,f.runId));
    expect(lease!.releasedAt).not.toBeNull();
  });

  it("project context redacts creator-run registered text in comments, documents and goals",async()=>{
    const f=await fixture(true,true),runId=randomUUID(),secret="SYNTHETIC-CONTEXT-SECRET-ONLY";
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.companyId,agentId:f.leadId,status:"succeeded",contextSnapshot:{issueId:randomUUID()}});
    await createRunSecretRedactionRegistry(db).register(f.companyId,runId,secret);
    const [prior]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.master.id,body:`Native prior ${secret}`,authorAgentId:f.leadId,authorType:"agent",createdByRunId:runId,createdAt:new Date(0)}).returning();
    await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"current-work",format:"markdown",body:`Document ${secret}`,createdByAgentId:f.leadId,createdByRunId:runId});
    const [goal]=await db.insert(goals).values({companyId:f.companyId,title:`Goal ${secret}`}).returning();
    await db.insert(projectGoals).values({companyId:f.companyId,projectId:f.projectId,goalId:goal!.id});
    const r=await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:{commentIds:[prior!.id]}});
    expect(r.status,JSON.stringify(r.body)).toBe(200);
    const saved=await documentService(db).getIssueDocumentByKey(r.body.attemptId,"coordinator-attempt-authority");
    expect(saved!.body).not.toContain(secret);
    expect(JSON.parse(saved!.body!).projectContext.goals[0].title).toContain("REDACTED");
  });


  it("project context intersects native master visibility even when the role can read its attempt",async()=>{
    const f=await activeFixture(await fixture(true,true));
    await db.update(issues).set({executionPolicy:{authorizationPolicy:{trustPreset:"low_trust_review",trustBoundary:{mode:"low_trust_review",companyId:f.companyId,rootIssueId:randomUUID()}}}}).where(eq(issues.id,f.master.id));
    const actor:AuthorizationActor={type:"agent",source:"agent_jwt",companyId:f.companyId,agentId:f.leadId,runId:f.runId,keyScope:{kind:"standard"},onBehalfOfUserId:f.userId};
    expect((await accessService(db).decide({actor,action:"issue:read",resource:{type:"issue",companyId:f.companyId,projectId:f.projectId,issueId:f.attemptId}})).allowed).toBe(true);
    expect((await accessService(db).decide({actor,action:"issue:read",resource:{type:"issue",companyId:f.companyId,projectId:f.projectId,issueId:f.master.id}})).allowed).toBe(false);
    expect((await f.context()).status).toBe(403);
  });

  it("project context rejects duplicated or oversized selection instead of silently truncating",async()=>{
    const f=await fixture(true,true);
    for (const selection of [{documentKeys:["plan","plan"]},{documentKeys:Array.from({length:5},(_,i)=>`extra-${i}`)},{commentIds:[f.comment.id,f.comment.id]}]) {
      expect((await request(f.app).post(`/api/issues/${f.intake.id}/coordinator-attempt`).send({...f.input,projectContext:selection})).status).toBe(400);
    }
    await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"plan",format:"markdown",body:"x".repeat(65536),createdByUserId:f.userId});
    expect((await f.prepare()).status).toBe(409);
  });

  it("prepares an existing local project workspace through the API without a seeded execution workspace", async () => {
    const f = await fixture(true);
    const prepared = await f.prepare();
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const context = await request(f.app).get(
      `/api/companies/${f.companyId}/issues/${prepared.body.attemptId}/intelligent-routing/context`,
    );
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, f.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceIssueId: prepared.body.attemptId,
      projectWorkspaceId: f.input.projectWorkspaceId,
      cwd: f.cwd,
      providerType: "local_fs",
      mode: "shared_workspace",
    });
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
  });

  it("requires an explicit workspace and refuses foreign, dynamic and unsafe paths before registration", async () => {
    const f = await fixture(),
      other = await fixture();
    const post = (input: object) =>
      request(f.app)
        .post(`/api/issues/${f.intake.id}/coordinator-attempt`)
        .send(input);
    const { projectWorkspaceId: _workspace, ...missing } = f.input;
    expect((await post(missing)).status).toBe(400);
    expect(
      (
        await post({
          ...f.input,
          projectWorkspaceId: other.input.projectWorkspaceId,
        })
      ).status,
    ).toBe(409);
    const alias = path.join(profileRoot, randomUUID());
    await fs.symlink(f.cwd, alias);
    const file = path.join(f.cwd, "not-directory");
    await fs.writeFile(file, "synthetic");
    const variants = [
      { setupCommand: "touch NEVER" },
      { cleanupCommand: "touch NEVER" },
      { sourceType: "remote", remoteProvider: "synthetic" },
      { metadata: { config: { provisionCommand: "touch NEVER" } } },
      { metadata: { workspaceRuntime: { command: "touch NEVER" } } },
      { cwd: alias },
      { cwd: path.join(alias, "child") },
      { cwd: file },
      { cwd: path.join(f.cwd, "absent") },
    ];
    await fs.mkdir(path.join(f.cwd, "child"));
    for (const patch of variants) {
      await db
        .update(projectWorkspaces)
        .set({
          cwd: f.cwd,
          sourceType: "local_path",
          setupCommand: null,
          cleanupCommand: null,
          remoteProvider: null,
          metadata: null,
          ...patch,
        })
        .where(eq(projectWorkspaces.id, f.input.projectWorkspaceId));
      expect((await post(f.input)).status, JSON.stringify(patch)).toBe(409);
    }
    expect(
      await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.companyId, f.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, f.companyId),
            eq(issues.originKind, "project_coordinator_attempt"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("rolls back attempt, workspace and authority together when document persistence fails", async () => {
    const f = await fixture();
    const beforeDocuments = await db
      .select()
      .from(documents)
      .where(eq(documents.companyId, f.companyId));
    await db.execute(
      sql.raw(
        `CREATE FUNCTION reject_workspace_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='coordinator-attempt-authority' AND NEW.company_id='${f.companyId}'::uuid THEN RAISE EXCEPTION 'synthetic authority insert refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_workspace_authority BEFORE INSERT ON issue_documents FOR EACH ROW EXECUTE FUNCTION reject_workspace_authority();`,
      ),
    );
    try {
      expect((await f.prepare()).status).toBe(500);
      expect(
        await db
          .select()
          .from(documents)
          .where(eq(documents.companyId, f.companyId)),
      ).toHaveLength(beforeDocuments.length);
      expect(
        await db
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.companyId, f.companyId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, f.companyId),
              eq(issues.originKind, "project_coordinator_attempt"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, f.companyId),
              eq(activityLog.action, "project.coordinator_attempt_prepared"),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await db.execute(
        sql.raw(
          "DROP TRIGGER reject_workspace_authority ON issue_documents; DROP FUNCTION reject_workspace_authority();",
        ),
      );
    }
    expect((await f.prepare()).status).toBe(200);
  });

  it.each([
    "closed",
    "closed_timestamp",
    "missing",
    "path",
    "attachment",
    "project_config",
  ])(
    "refuses %s workspace drift on replay without recreating ownership",
    async (kind) => {
      const f = await fixture();
      const prepared = await f.prepare();
      expect(prepared.status).toBe(200);
      const id = prepared.body.workspace.executionWorkspaceId as string;
      if (kind === "closed")
        await db
          .update(executionWorkspaces)
          .set({ status: "closed" })
          .where(eq(executionWorkspaces.id, id));
      if (kind === "closed_timestamp")
        await db
          .update(executionWorkspaces)
          .set({ status: "active", closedAt: new Date() })
          .where(eq(executionWorkspaces.id, id));
      if (kind === "missing") {
        await db
          .update(issues)
          .set({ executionWorkspaceId: null })
          .where(eq(issues.id, prepared.body.attemptId));
        await db
          .delete(executionWorkspaces)
          .where(eq(executionWorkspaces.id, id));
      }
      if (kind === "path") {
        await fs.rename(f.cwd, f.cwd + "-moved");
        await fs.symlink(f.cwd + "-moved", f.cwd);
      }
      if (kind === "attachment")
        await db
          .update(issues)
          .set({ executionWorkspacePreference: "inherit" })
          .where(eq(issues.id, prepared.body.attemptId));
      if (kind === "project_config")
        await db
          .update(projects)
          .set({ executionWorkspacePolicy: { mode: "isolated_workspace" } })
          .where(eq(projects.id, f.projectId));
      expect((await f.prepare()).status).toBe(409);
      expect(
        await db
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.companyId, f.companyId)),
      ).toHaveLength(kind === "missing" ? 0 : 1);
    },
  );

  it("refuses a changed requested workspace and legacy unpinned authority without replacing the original row", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect(prepared.status).toBe(200);
    const [other] = await db
      .insert(projectWorkspaces)
      .values({
        companyId: f.companyId,
        projectId: f.projectId,
        name: "Other local selection",
        cwd: f.cwd,
      })
      .returning();
    const changed = await request(f.app)
      .post(`/api/issues/${f.intake.id}/coordinator-attempt`)
      .send({ ...f.input, projectWorkspaceId: other!.id });
    expect(changed.status).toBe(409);
    const doc = await documentService(db).getIssueDocumentByKey(
      prepared.body.attemptId,
      "coordinator-attempt-authority",
    );
    const old = JSON.parse(doc!.body!);
    delete old.workspace;
    const body = JSON.stringify(old);
    await db
      .update(documents)
      .set({ latestBody: body })
      .where(eq(documents.id, doc!.id));
    await db
      .update(issues)
      .set({
        originFingerprint: createHash("sha256").update(body).digest("hex"),
      })
      .where(eq(issues.id, prepared.body.attemptId));
    expect((await f.prepare()).status).toBe(409);
    expect(
      await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.companyId, f.companyId)),
    ).toHaveLength(1);
  });

  async function qualifiedFixture(base?: Awaited<ReturnType<typeof fixture>>, existing?: {attemptId: string; authorityDigest: string}) {
    const f = base ?? (await fixture(true));
    const next = base && !existing
      ? await projectCoordinatorIntakeService(db).addComment({
          masterId: f.master.id,
          body: "Second synthetic request",
          requestId: randomUUID(),
          actor: f.actor,
          sourceTrust: null,
        })
      : null;
    const prepared = existing ? {status:200,body:existing} : next
      ? {
          status: 200,
          body: await projectCoordinatorAttemptService(db).prepare(
            next.intake.id,
            f.actor,
            f.input,
          ),
        }
      : await f.prepare();
    expect(prepared.status).toBe(200);
    const attemptId = prepared.body.attemptId as string;
    const contracts = intelligentRoutingContractService(db, {
      resolveSnapshot: resolveExecutionBindingSnapshot,
    });
    const context = await contracts.context(f.companyId, attemptId);
    expect(
      context.profiles.find((p) => p.bindingId === f.bindingId)
        ?.configurationDigest,
    ).toBe(f.policy.profiles[0]!.configurationDigest);
    const profile = f.policy.profiles[0]!;
    const now = new Date(),
      expiresAt = new Date(Date.now() + 600_000).toISOString(),
      profileDigest = digest(profile);
    const requirements: IntelligentRoutingContractInput["requirements"] = {
      version: 1,
      taskFamily: "synthetic-coordination",
      benchmarkDigest: digest("benchmark"),
      benchmarkCaseDigests: Array.from({ length: 20 }, (_, i) =>
        digest(`case-${i}`),
      ),
      rubricDigest: digest("rubric"),
      evaluationPolicyDigest: digest("eval-policy"),
      trustedEvaluatorProfileDigests: [digest("evaluator")],
      frontierReviewerProfileDigests: [digest("reviewer")],
      requiredCapabilities: ["text"],
      requiredModalities: ["text"],
      requiredContextTokens: 10000,
      dataClass: f.policy.dataClass,
      risk: "low",
      minimumQualityLowerBound: 0.7,
      minimumSampleCount: 20,
      requireFrontierReview: true,
      maximumObservationAgeMs: 300_000,
      frontierBaselineProfileDigests: [],
    };
    const input: IntelligentRoutingContractInput = {
      expectedInputDigest: context.inputDigest,
      expectedRevision: context.latestRevision,
      requirements,
      candidates: [
        {
          profile,
          advertisedCapabilities: ["text"],
          baseline: null,
          observation: {
            version: 1,
            profileDigest,
            observedAt: now.toISOString(),
            expiresAt,
            available: true,
            availableCapacity: 1,
            remainingQuota: null,
            billingRoute: "native_subscription",
            billingApproved: true,
          },
          evaluations: [
            {
              version: 1,
              id: "synthetic-evaluation",
              profileDigest,
              taskFamily: requirements.taskFamily,
              benchmarkDigest: requirements.benchmarkDigest,
              rubricDigest: requirements.rubricDigest,
              evaluationPolicyDigest: requirements.evaluationPolicyDigest,
              capabilities: ["text"],
              modalities: ["text"],
              contextTokens: 10000,
              risks: ["low"],
              recordedAt: now.toISOString(),
              expiresAt,
              evidenceRef: "fixture://no-provider-evaluation",
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
    const contract = await contracts.create(
      f.companyId,
      attemptId,
      input,
      f.userId,
    );
    expect(contract.decision.status).toBe("selected");
    return {
      ...f,
      attemptId,
      prepared,
      contract,
      routingInput: input,
      start: {
        expectedAuthorityDigest: prepared.body.authorityDigest,
        expectedRoutingRevision: contract.revision,
      },
    };
  }

  it("ordinary master input automatically starts one attributed run and recovers without replay", async () => {
    const f = await qualifiedFixture();
    await db.update(projects).set({ coordinationPolicyRevision: 2, coordinationPolicy: {
      ...f.policy,
      automaticExecution: {
        projectWorkspaceId: f.input.projectWorkspaceId,
        centralCompanyId: f.companyId,
        centralPolicyDigest: f.input.expectedCentralPolicyDigest,
        coordinator: { requirements: f.routingInput.requirements, candidates: f.routingInput.candidates },
      },
    } }).where(eq(projects.id, f.projectId));
    const original = getServerAdapter("claude_local");
    registerServerAdapter({ ...original, execute: async (ctx) => {
      const result = await original.execute(ctx);
      const claims = verifyLocalAgentJwt(ctx.authToken!)!;
      await projectCoordinatorAttemptService(db).taskEnvelope(String(ctx.context.issueId), {
        type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: f.leadId,
        runId: ctx.runId, onBehalfOfUserId: f.userId, keyScope: claims.key_scope!,
      }, "The requested synthetic answer is blue.");
      return result;
    } });
    const heartbeat = heartbeatService(db);
    try {
      const intakeRequestId = randomUUID();
      const post = () => request(f.app).post(`/api/issues/${f.master.id}/comments`).send({
        body: "Give the synthetic answer in this conversation.", intakeRequestId,
      });
      const accepted = await post();
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      await heartbeat.drainActiveRunExecutions();
      await post();
      await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      expect(runs.map(r => ({ status: r.status, error: r.error }))).toEqual([{ status: "succeeded", error: null }]);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.master.id));
      expect(comments.filter(c => c.body.includes("The requested synthetic answer is blue."))).toHaveLength(1);
      expect(comments.some(c => c.body.includes("awaiting review"))).toBe(true);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(original);
    }
  });

  it("ordinary master input hands off only after parent release and publishes the distinct specialist result once", async () => {
    const f = await specialistFixture();
    // Close the qualification fixture before enabling automatic execution for new intake.
    expect((await f.put({ body: "Prior qualification only" })).status).toBe(200);
    await f.finish();
    const specialistProfile = f.specialistHandoff.profile;
    const specialistCandidates = f.routingInput.candidates.map(candidate => ({
      ...candidate, profile: specialistProfile,
      observation: { ...candidate.observation, profileDigest: digest(specialistProfile) },
      evaluations: candidate.evaluations.map(evaluation => ({ ...evaluation, profileDigest: digest(specialistProfile) })),
    }));
    await db.update(projects).set({ coordinationPolicyRevision: 2, coordinationPolicy: {
      ...f.policy,
      automaticExecution: {
        projectWorkspaceId: f.input.projectWorkspaceId, centralCompanyId: f.companyId,
        centralPolicyDigest: f.input.expectedCentralPolicyDigest,
        coordinator: { requirements: f.routingInput.requirements, candidates: f.routingInput.candidates },
        specialist: { requirements: f.routingInput.requirements, candidates: specialistCandidates },
      },
    } }).where(eq(projects.id, f.projectId));
    const original = getServerAdapter("claude_local"), heartbeat = heartbeatService(db);
    const invoked: string[] = [];
    registerServerAdapter({ ...original, execute: async ctx => {
      invoked.push(ctx.agent.id);
      if (ctx.agent.id === f.specialistId) {
        const leases = await db.select().from(runExecutionBindings).where(eq(runExecutionBindings.companyId, f.companyId));
        expect(leases.filter(lease => lease.runId !== ctx.runId).every(lease => lease.releasedAt !== null)).toBe(true);
        expect(ctx.context.coordinatorPrompt).toContain("Automatic coordinator finding");
      }
      const result = await original.execute(ctx), claims = verifyLocalAgentJwt(ctx.authToken!)!;
      await projectCoordinatorAttemptService(db).taskEnvelope(String(ctx.context.issueId), {
        type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: ctx.agent.id,
        runId: ctx.runId, onBehalfOfUserId: f.userId, keyScope: claims.key_scope!,
      }, ctx.agent.id === f.leadId ? "Automatic coordinator finding" : "Independent specialist found a missing constraint",
      ctx.agent.id === f.leadId ? f.handoff : undefined);
      return result;
    } });
    try {
      const accepted = await request(f.app).post(`/api/issues/${f.master.id}/comments`).send({
        body: "Produce a finding and request independent review.", intakeRequestId: randomUUID(),
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      await heartbeat.drainActiveRunExecutions();
      await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
      await heartbeat.drainActiveRunExecutions();
      expect(invoked).toEqual([f.leadId, f.specialistId]);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.master.id));
      expect(comments.filter(c => c.body.includes("Automatic coordinator finding"))).toHaveLength(1);
      expect(comments.filter(c => c.body.includes("Independent specialist found a missing constraint"))).toHaveLength(1);
      const specialist = await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.assigneeAgentId, f.specialistId)));
      expect(specialist.map(s => s.status)).toEqual(["in_review"]);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(original);
    }
  });

  it.each(["expired evidence", "revoked execution permission"])("automatic recovery reports %s without starting a run", async problem => {
    const f = await qualifiedFixture();
    const candidates = structuredClone(f.routingInput.candidates);
    if (problem === "expired evidence") candidates[0]!.observation.expiresAt = new Date(Date.now() - 1000).toISOString();
    await db.update(projects).set({ coordinationPolicyRevision: 2, coordinationPolicy: {
      ...f.policy, automaticExecution: {
        projectWorkspaceId: f.input.projectWorkspaceId, centralCompanyId: f.companyId,
        centralPolicyDigest: f.input.expectedCentralPolicyDigest,
        coordinator: { requirements: f.routingInput.requirements, candidates },
      },
    } }).where(eq(projects.id, f.projectId));
    const intake = await projectCoordinatorIntakeService(db).addComment({ masterId:f.master.id,
      body:"This request must stay blocked", requestId:randomUUID(), actor:f.actor, sourceTrust:null });
    if (problem === "revoked execution permission") await db.update(companyMemberships).set({ membershipRole:"viewer" })
      .where(and(eq(companyMemberships.companyId,f.companyId),eq(companyMemberships.principalId,f.userId)));
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.companyId))).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId,f.master.id));
    expect(comments.filter(c=>c.body.includes(`/issues/${intake.intake.id}`) && c.body.includes("is waiting:"))).toHaveLength(1);
  });

  it("redacts the originating run secrets before copying its result into the master", async () => {
    const f = await specialistFixture(), secret = "SYNTHETIC-CHILD-SECRET-DO-NOT-PUBLISH";
    await createRunSecretRedactionRegistry(db).register(f.companyId, f.runId, secret);
    expect((await f.put({ body: `A finding with ${secret}` })).status).toBe(200);
    await f.finish();
    const comments = await request(f.app).get(`/api/issues/${f.master.id}/comments`);
    expect(comments.status).toBe(200);
    expect(JSON.stringify(comments.body)).not.toContain(secret);
    expect(JSON.stringify(comments.body)).toContain("REDACTED");
    const result = await documentService(db).getIssueDocumentByKey(f.attemptId, "coordinator-result");
    expect(result!.body).toContain(secret);
  });

  it("preserves a legacy settlement notice when its run is settled again", async () => {
    const f = await specialistFixture();
    expect((await f.put({ body: "Historical result must not be republished" })).status).toBe(200);
    const body = `[Coordinator result](/issues/${f.attemptId}#document-coordinator-result) is awaiting review.`;
    await db.insert(issueComments).values({ companyId:f.companyId, issueId:f.master.id,
      authorType:"system", createdByRunId:f.runId, body });
    await f.finish();
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId,f.master.id),eq(issueComments.createdByRunId,f.runId)));
    expect(notices.map(comment=>comment.body)).toEqual([body]);
  });

  it("serialises separate intake admissions against the existing project capacity", async () => {
    const f = await qualifiedFixture();
    const other = await qualifiedFixture(f);
    const service = projectCoordinatorAttemptService(db);
    const result = await Promise.allSettled([
      service.admit(f.attemptId, f.actor, f.start),
      service.admit(other.attemptId, other.actor, other.start),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(issues)
        .where(
          and(eq(issues.projectId, f.projectId), eq(issues.status, "todo")),
        ),
    ).toHaveLength(1);
  });

  it("runs one finite inert Claude child through heartbeat and settles an attributed result after lease release", async () => {
    const f = await qualifiedFixture();
    const original = getServerAdapter("claude_local");
    let invocations = 0,
      spawns = 0;
    registerServerAdapter({
      ...original,
      execute: async (ctx) => {
        invocations++;
        const result = await original.execute({
          ...ctx,
          onSpawn: async (meta) => {
            spawns++;
            await ctx.onSpawn?.(meta);
          },
        });
        const claims = verifyLocalAgentJwt(ctx.authToken!);
        expect(claims?.key_scope).toMatchObject({
          kind: "project_coordinator",
          attemptIssueId: f.attemptId,
        });
        const actor: AuthorizationActor = {
          type: "agent",
          source: "agent_jwt",
          companyId: f.companyId,
          agentId: f.leadId,
          runId: ctx.runId,
          onBehalfOfUserId: f.userId,
          keyScope: claims!.key_scope!,
        };
        await projectCoordinatorAttemptService(db).taskEnvelope(
          f.attemptId,
          actor,
          "Synthetic result, checked by the inert fixture",
        );
        return result;
      },
    });
    const heartbeat = heartbeatService(db);
    try {
      await projectCoordinatorAttemptService(db).admit(
        f.attemptId,
        f.actor,
        f.start,
      );
      // Simulate process restart after committed admission but before first wake.
      // Concurrent ticks must still create exactly one run.
      await Promise.all([
        heartbeat.resumeQueuedRuns(),
        heartbeat.resumeQueuedRuns(),
      ]);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId));
      expect(runs.map((r) => ({ status: r.status, error: r.error }))).toEqual([
        { status: "succeeded", error: null },
      ]);
      expect(invocations).toBe(1);
      expect(spawns).toBe(1);
      const [lease] = await db
        .select()
        .from(runExecutionBindings)
        .where(eq(runExecutionBindings.runId, runs[0]!.id));
      expect(lease!.releasedAt).not.toBeNull();
      expect(lease!.processHistory).toHaveLength(1);
      const [attempt] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.attemptId));
      expect(attempt).toMatchObject({
        status: "in_review",
        executionRunId: null,
        checkoutRunId: null,
      });
      await heartbeat.wakeup(f.leadId, {
        source: "on_demand",
        contextSnapshot: { issueId: f.attemptId },
        requestedByActorType: "user",
        requestedByActorId: f.userId,
      });
      await heartbeat.drainActiveRunExecutions();
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, f.companyId)),
      ).toHaveLength(1);
      expect(spawns).toBe(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(original);
    }
  });

  it.each([
    "source",
    "project-context",
    "workspace_ref",
    "workspace_path",
    "workspace_config",
    "role_config",
    "archive",
  ])(
    "refuses %s drift at the real pre-spawn gate and releases an unstarted lease",
    async (kind) => {
      const f = kind === "project-context" ? await qualifiedFixture(await fixture(true,true)) : await qualifiedFixture();
      const original = getServerAdapter("claude_local");
      let callbacks = 0;
      registerServerAdapter({
        ...original,
        execute: async () => {
          callbacks++;
          throw new Error("Must not reach adapter");
        },
      });
      const heartbeat = heartbeatService(db, {
        beforeResolvedInteractionContinuationDispatchCheck: async () => {
          if(kind === "project-context") await documentService(db).upsertIssueDocument({issueId:f.master.id,key:"current-work",format:"markdown",body:"Changed project constraint",createdByUserId:f.userId});
          if (kind === "source")
            await db
              .update(issueComments)
              .set({ body: "Changed after admission" })
              .where(eq(issueComments.id, f.comment.id));
          if (kind === "workspace_ref")
            await db
              .update(projectWorkspaces)
              .set({ repoRef: "unapproved-ref" })
              .where(eq(projectWorkspaces.projectId, f.projectId));
          if (kind === "workspace_path")
            await db
              .update(executionWorkspaces)
              .set({ cwd: profileRoot })
              .where(eq(executionWorkspaces.projectId, f.projectId));
          if (kind === "workspace_config")
            await db
              .update(executionWorkspaces)
              .set({ metadata: { runtimeConfig: { command: "unapproved" } } })
              .where(eq(executionWorkspaces.projectId, f.projectId));
          if (kind === "role_config") {
            const [lead] = await db
              .select()
              .from(agents)
              .where(eq(agents.id, f.leadId));
            await db
              .update(agents)
              .set({
                adapterConfig: { ...lead!.adapterConfig, maxTurnsPerRun: 3 },
              })
              .where(eq(agents.id, f.leadId));
          }
          if (kind === "archive")
            await db
              .update(projects)
              .set({ archivedAt: new Date() })
              .where(eq(projects.id, f.projectId));
        },
      });
      try {
        await projectCoordinatorAttemptService(db).admit(
          f.attemptId,
          f.actor,
          f.start,
        );
        await heartbeat.wakeup(f.leadId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "project_coordinator_admitted",
          requestedByActorType: "user",
          requestedByActorId: f.userId,
          contextSnapshot: { issueId: f.attemptId },
        });
        await heartbeat.drainActiveRunExecutions();
        expect(callbacks).toBe(0);
        const [run] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, f.companyId));
        expect(["failed", "cancelled"]).toContain(run!.status);
        const [lease] = await db
          .select()
          .from(runExecutionBindings)
          .where(eq(runExecutionBindings.runId, run!.id));
        expect(lease!.releasedAt).not.toBeNull();
        expect(lease!.processHistory).toEqual([]);
        const rows = await db
          .select()
          .from(issues)
          .where(eq(issues.projectId, f.projectId));
        expect(rows.every((i) => !i.executionRunId && !i.checkoutRunId)).toBe(
          true,
        );
        expect(rows.find((i) => i.id === f.attemptId)!.status).toBe("blocked");
      } finally {
        await heartbeat.drainActiveRunExecutions();
        registerServerAdapter(original);
      }
    },
  );

  it("takes the existing project lock before claiming a queued attempt racing archive", async () => {
    const f = await qualifiedFixture(),
      service = projectCoordinatorAttemptService(db);
    await service.admit(f.attemptId, f.actor, f.start);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.leadId,
        nativeIssueId: f.attemptId,
        contextSnapshot: { issueId: f.attemptId },
        responsibleUserId: f.userId,
        status: "queued",
      })
      .returning();
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const original = getServerAdapter("claude_local");
    let callbacks = 0;
    registerServerAdapter({
      ...original,
      execute: async () => {
        callbacks++;
        throw new Error("Must not execute");
      },
    });
    const heartbeat = heartbeatService(db);
    const edit = db.transaction(async (tx) => {
      await tx
        .select()
        .from(projects)
        .where(eq(projects.id, f.projectId))
        .for("update");
      locked();
      await held;
      await tx
        .update(projects)
        .set({ archivedAt: new Date() })
        .where(eq(projects.id, f.projectId));
    });
    try {
      await ready;
      const resumed = heartbeat.resumeQueuedRuns();
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%projects%'`,
        );
        if (Number(rows[0]?.n) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release();
      await edit;
      await resumed;
      await heartbeat.drainActiveRunExecutions();
      expect(callbacks).toBe(0);
      expect(await heartbeat.getRun(run!.id)).toMatchObject({
        status: "cancelled",
      });
      expect(
        (await db.select().from(issues).where(eq(issues.id, f.attemptId)))[0],
      ).toMatchObject({
        status: "blocked",
        executionRunId: null,
        checkoutRunId: null,
      });
      expect(
        await db
          .select()
          .from(runExecutionBindings)
          .where(eq(runExecutionBindings.companyId, f.companyId)),
      ).toEqual([]);
    } finally {
      release();
      await edit;
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(original);
    }
  });

  it("keeps the start API board-only and strict before admission", async () => {
    const f = await qualifiedFixture();
    const standard = createLocalAgentJwt(
      f.leadId,
      f.companyId,
      "claude_local",
      randomUUID(),
      f.userId,
    )!;
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.attemptId}/coordinator-start`)
          .set("Authorization", `Bearer ${standard}`)
          .send(f.start)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.attemptId}/coordinator-start`)
          .send({ ...f.start, scope: { kind: "project_coordinator" } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.attemptId}/coordinator-start`)
          .send({ ...f.start, expectedRoutingRevision: 99 })
      ).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toEqual([]);
  });

  it("admits one board-qualified child idempotently and refuses a second native run", async () => {
    const f = await qualifiedFixture();
    const service = projectCoordinatorAttemptService(db);
    const results = await Promise.all([
      service.admit(f.attemptId, f.actor, f.start),
      service.admit(f.attemptId, f.actor, f.start),
    ]);
    expect(results.every((r) => r.enqueue)).toBe(true);
    const [attempt] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.attemptId));
    expect(attempt).toMatchObject({
      status: "todo",
      assigneeAgentId: f.leadId,
      executionRunId: null,
    });
    await db.transaction((tx) =>
      assertCoordinatorRunAdmission(tx as never, {
        companyId: f.companyId,
        attemptId: f.attemptId,
        agentId: f.leadId,
      }),
    );
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.leadId,
        nativeIssueId: f.attemptId,
        contextSnapshot: { issueId: f.attemptId },
        responsibleUserId: f.userId,
        status: "queued",
      })
      .returning();
    await expect(
      db.transaction((tx) =>
        assertCoordinatorRunAdmission(tx as never, {
          companyId: f.companyId,
          attemptId: f.attemptId,
          agentId: f.leadId,
        }),
      ),
    ).rejects.toThrow("only one fresh run");
    await expect(
      service.admit(f.attemptId, f.actor, f.start),
    ).resolves.toMatchObject({ enqueue: false, runId: run!.id });
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run!.id));
    await expect(service.settle(f.attemptId, run!.id)).resolves.toEqual({
      status: "blocked",
    });
    await expect(
      service.admit(f.attemptId, f.actor, f.start),
    ).resolves.toMatchObject({ enqueue: false });
    const sources = await db
      .select()
      .from(issues)
      .where(eq(issues.projectId, f.projectId));
    expect(
      sources
        .filter((i) => i.originKind !== "project_coordinator_attempt")
        .every(
          (i) => !i.assigneeAgentId && !i.executionRunId && !i.checkoutRunId,
        ),
    ).toBe(true);
  });

  it("refuses source or responsible-user drift after admission without creating a lease", async () => {
    const f = await qualifiedFixture();
    const service = projectCoordinatorAttemptService(db);
    await service.admit(f.attemptId, f.actor, f.start);
    await db
      .update(companyMemberships)
      .set({ status: "inactive" })
      .where(
        and(
          eq(companyMemberships.companyId, f.companyId),
          eq(companyMemberships.principalId, f.userId),
        ),
      );
    await expect(
      db.transaction((tx) =>
        assertCoordinatorRunAdmission(tx as never, {
          companyId: f.companyId,
          attemptId: f.attemptId,
          agentId: f.leadId,
        }),
      ),
    ).rejects.toThrow("responsible user");
    expect(
      await db
        .select()
        .from(runExecutionBindings)
        .where(eq(runExecutionBindings.companyId, f.companyId)),
    ).toEqual([]);
  });

  it("concurrent preparation/restart returns one permanent blocked child and immutable authority", async () => {
    const f = await fixture();
    const responses = await Promise.all([
      f.prepare(),
      f.prepare(),
      f.prepare(),
    ]);
    responses.forEach((r) =>
      expect(r.status, JSON.stringify(r.body)).toBe(200),
    );
    expect(new Set(responses.map((r) => r.body.attemptId)).size).toBe(1);
    expect(
      new Set(responses.map((r) => r.body.workspace.executionWorkspaceId)).size,
    ).toBe(1);
    expect(
      await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.companyId, f.companyId)),
    ).toHaveLength(1);
    const id = responses[0]!.body.attemptId;
    expect(
      (
        await projectCoordinatorAttemptService(db).prepare(
          f.intake.id,
          f.actor,
          f.input,
        )
      ).attemptId,
    ).toBe(id);
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    expect(row).toMatchObject({
      parentId: f.intake.id,
      status: "blocked",
      assigneeAgentId: null,
      executionRunId: null,
      checkoutRunId: null,
    });
    expect(responses[0]!.body.executionReady).toBe(false);
    await expect(
      issueService(db).update(id, {
        status: "todo",
        assigneeAgentId: f.leadId,
      }),
    ).rejects.toThrow();
    await expect(
      issueService(db).checkout(id, f.leadId, ["blocked"], randomUUID()),
    ).rejects.toThrow();
    await expect(
      documentService(db).upsertIssueDocument({
        issueId: id,
        key: "coordinator-attempt-authority",
        format: "markdown",
        body: "forged",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(issues).values({
        companyId: f.companyId,
        title: "duplicate",
        originKind: "project_coordinator_attempt",
        originId: f.intake.id,
      }),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(0);
  });
  it("refuses foreign, forged, archived, changed-source and stale-policy preparation", async () => {
    const f = await fixture();
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.intake.id}/coordinator-attempt`)
          .send({ ...f.input, authorityDigest: "a".repeat(64) })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.intake.id}/coordinator-attempt`)
          .send({ ...f.input, expectedPolicyRevision: 0 })
      ).status,
    ).toBe(409);
    const other = await fixture();
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${f.intake.id}/coordinator-attempt`)
          .send({ ...f.input, centralCompanyId: other.companyId })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post(`/api/issues/${other.intake.id}/coordinator-attempt`)
          .send(f.input)
      ).status,
    ).toBe(404);
    await db
      .update(issueComments)
      .set({ body: "Edited after intake" })
      .where(eq(issueComments.id, f.comment.id));
    expect((await f.prepare()).status).toBe(409);
    await db
      .update(issueComments)
      .set({ body: f.comment.body })
      .where(eq(issueComments.id, f.comment.id));
    await db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, f.projectId));
    expect((await f.prepare()).status).toBe(409);
  });

  it("refuses coordinator admission without board-approved qualified routing", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect(prepared.status).toBe(200);
    const response = await request(f.app)
      .post(`/api/issues/${prepared.body.attemptId}/coordinator-start`)
      .send({
        expectedAuthorityDigest: prepared.body.authorityDigest,
        expectedRoutingRevision: 1,
      });
    expect(response.status).toBe(409);
    const [attempt] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, prepared.body.attemptId));
    expect(attempt?.assigneeAgentId).toBeNull();
    expect(attempt?.status).toBe("blocked");
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(0);
  });
  async function specialistFixture(withContext = false) {
    const f = await fixture(true, withContext);
    const specialistId = randomUUID(),
      specialistBindingId = randomUUID(),
      skillId = randomUUID(),
      versionId = randomUUID();
    const cwd = path.join(f.cwd, "specialist-workspace");
    await fs.mkdir(cwd);
    execFileSync("git", ["init", "--quiet", cwd]);
    await fs.mkdir(path.join(cwd, "profile"));
    const [lead] = await db.select().from(agents).where(eq(agents.id, f.leadId));
    await db
      .insert(agents)
      .values({
        id: specialistId,
        companyId: f.companyId,
        name: "Synthetic specialist",
        adapterType: "claude_local",
        status: "idle",
        adapterConfig: { ...lead!.adapterConfig, cwd, maxTurnsPerRun: 1 },
      });
    const definition = {
      ...f.definition,
      accountKey: `specialist-${f.companyId}`,
      nativeProfileHome: path.join(cwd, "profile"),
      allowedAgentIds: [specialistId],
    };
    const [bindingRow] = await db
      .insert(executionBindings)
      .values({
        id: specialistBindingId,
        companyId: f.companyId,
        enabled: true,
        profileRoots: [definition.nativeProfileHome],
        definition,
      })
      .returning();
    const [role] = await db.select().from(agents).where(eq(agents.id, specialistId));
    const binding = {
      ...definition,
      id: specialistBindingId,
      companyId: f.companyId,
      enabled: true,
      createdAt: bindingRow!.createdAt,
    };
    const snapshot = resolveExecutionBindingSnapshot({
      binding,
      agent: role!,
      selection: {
        bindingId: specialistBindingId,
        model: "synthetic-model",
        dataClass: f.policy.dataClass,
        requiredCapabilities: ["text"],
        evidenceRefs: ["synthetic-only"],
        reason: "Fixture",
      },
      taskKey: "fixture",
      deliveryMode: "manifest_coordinator",
    });
    const configurationDigest = routingConfigurationDigest(
      snapshot.adapterConfig,
      role!.permissions,
      await collectIntelligentRoutingRuntimeFingerprint({
        binding,
        adapterConfig: snapshot.adapterConfig,
        runtimeFilePaths: definition.runtimeFilePaths,
      }),
    );
    const profile = {
      ...f.policy.profiles[0]!,
      bindingId: specialistBindingId,
      accountKey: definition.accountKey,
      configurationDigest,
    };
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({ companyId: f.companyId, projectId: f.projectId, name: "Specialist", cwd })
      .returning();
    await db
      .insert(companySkills)
      .values({
        id: skillId,
        companyId: f.companyId,
        key: "specialist-skill",
        slug: "specialist-skill",
        name: "Specialist",
        markdown: "Synthetic",
      });
    await db
      .insert(companySkillVersions)
      .values({
        id: versionId,
        companyId: f.companyId,
        companySkillId: skillId,
        revisionNumber: 1,
        fileInventory: [
          { path: "SKILL.md", kind: "skill", content: "specialist-only skill marker" },
        ] as never,
      });
    const specialistHandoff = {
      roleKey: "independent-review",
      agentId: specialistId,
      profile,
      skills: [{ key: "specialist-skill", versionId }],
      projectWorkspaceId: workspace!.id,
      maxTurns: 1,
    };
    const policy = { ...f.policy, specialistHandoff };
    await db
      .update(projects)
      .set({ coordinationPolicy: policy })
      .where(eq(projects.id, f.projectId));
    const active = await activeFixture({ ...f, policy });
    const handoff = {
      roleKey: specialistHandoff.roleKey,
      brief: "Review the bounded parent finding",
      acceptanceCriteria: ["Report one independently checked observation"],
    };
    const put = (payload: object) =>
      request(f.app)
        .put(`/api/issues/${active.attemptId}/coordinator-result`)
        .set("Authorization", `Bearer ${active.token}`)
        .send(payload);
    const children = () =>
      db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, f.companyId),
            eq(issues.originKind, "project_coordinator_attempt"),
            eq(issues.originId, active.attemptId),
          ),
        );
    async function finish(status = "succeeded", release = true) {
      await db
        .update(heartbeatRuns)
        .set({ status, finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, active.runId));
      if (release)
        await db
          .update(runExecutionBindings)
          .set({ releasedAt: new Date(), releaseReason: "synthetic no-process fixture" })
          .where(eq(runExecutionBindings.runId, active.runId));
      return projectCoordinatorAttemptService(db).settle(active.attemptId, active.runId);
    }
    return {
      ...active,
      policy,
      specialistId,
      specialistBindingId,
      specialistDefinition: definition,
      specialistHandoff,
      handoff,
      put,
      children,
      finish,
    };
  }

  async function activeFixture(base?: Awaited<ReturnType<typeof fixture>>) {
    const f = base ?? await fixture(true),
      prepared = await f.prepare();
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const { attemptId, authorityDigest } = prepared.body,
      runId = randomUUID();
    const routed = await qualifiedFixture(f, {attemptId,authorityDigest});
    await projectCoordinatorAttemptService(db).admit(attemptId,f.actor,routed.start);
    // Native qualification and lease acquisition; no adapter execution or provider.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.leadId,
      status: "running",
      nativeIssueId: attemptId,
      responsibleUserId: f.userId,
      contextSnapshot: { issueId: attemptId },
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: f.leadId,
        executionRunId: runId,
      })
      .where(eq(issues.id, attemptId));
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
    const [lead]=await db.select().from(agents).where(eq(agents.id,f.leadId));
    const acquired=await executionBindingService(db).acquire(run!,lead!);
    expect(acquired?.routingReceipt?.contractId).toBe(routed.contract.id);
    const token = createLocalAgentJwt(
      f.leadId,
      f.companyId,
      "claude_local",
      runId,
      f.userId,
      {
        kind: "project_coordinator",
        projectId: f.projectId,
        intakeIssueId: f.intake.id,
        attemptIssueId: attemptId,
        authorityDigest,
      },
    )!;
    const context = () =>
      request(f.app)
        .get(`/api/issues/${attemptId}/coordinator-context`)
        .set("Authorization", `Bearer ${token}`);
    return { ...f, attemptId, runId, token, context, contract:routed.contract, routingInput:routed.routingInput, acquired:acquired! };
  }

  it("availability projects only the exact native acquired contract and keeps result replay valid", async()=>{
    const f=await activeFixture();
    const r=await f.context();
    expect(r.status,JSON.stringify(r.body)).toBe(200);
    expect(r.body.availability).toMatchObject({version:1,provenance:"board_recorded",runId:f.runId,contractId:f.contract.id,contractRevision:f.contract.revision,profileDigest:f.acquired.routingReceipt!.profileDigest,model:"synthetic-model",observation:{remainingQuota:null}});
    expect(JSON.stringify(r.body.availability)).not.toMatch(/evaluations|evaluator|nativeProfileHome|private-home|candidateEvidenceSnapshot/);
    const put=()=>request(f.app).put(`/api/issues/${f.attemptId}/coordinator-result`).set("Authorization",`Bearer ${f.token}`).send({body:"Finite availability-bound result"});
    const first=await put();expect(first.status).toBe(200);expect((await put()).body.id).toBe(first.body.id);
  });


  for(const kind of ["missing-receipt","contract-id","revision","input-digest","requirements-digest","profile-digest","creator","assignee","duplicate-candidate","malformed-candidate","profile-model","observation-profile","unavailable","zero-capacity","zero-quota","billing","future","effective-expiry","binding-expiry","invalid-binding-expiry","evaluation-expiry"] as const) {
    it(`availability refuses ${kind} for both scoped GET and PUT`,async()=>{
      const f=await activeFixture();
      const [lease]=await db.select().from(runExecutionBindings).where(eq(runExecutionBindings.runId,f.runId));
      const snapshot=structuredClone(lease!.snapshot);
      const candidates=structuredClone(f.contract.candidateEvidenceSnapshot) as IntelligentRoutingContractInput["candidates"];
      const c=candidates[0]!;
      let clock:ReturnType<typeof vi.spyOn>|undefined;
      if(kind==="missing-receipt") delete snapshot.routingReceipt;
      if(kind==="contract-id") snapshot.routingReceipt!.contractId=randomUUID();
      if(kind==="revision") snapshot.routingReceipt!.revision++;
      if(kind==="input-digest") snapshot.routingReceipt!.inputDigest="f".repeat(64);
      if(kind==="requirements-digest") snapshot.routingReceipt!.requirementsDigest="f".repeat(64);
      if(kind==="profile-digest") snapshot.routingReceipt!.profileDigest="f".repeat(64);
      await db.update(runExecutionBindings).set({snapshot}).where(eq(runExecutionBindings.runId,f.runId));
      if(kind==="creator") await db.update(intelligentRoutingContracts).set({createdByUserId:randomUUID()}).where(eq(intelligentRoutingContracts.id,f.contract.id));
      if(kind==="assignee") await db.update(intelligentRoutingContracts).set({assigneeAgentId:randomUUID()}).where(eq(intelligentRoutingContracts.id,f.contract.id));
      if(kind==="duplicate-candidate") candidates.push(structuredClone(c));
      if(kind==="malformed-candidate") await db.update(intelligentRoutingContracts).set({candidateEvidenceSnapshot:[{profile:"invalid"}]}).where(eq(intelligentRoutingContracts.id,f.contract.id));
      if(kind==="profile-model") c.profile.model="unqualified-model";
      if(kind==="observation-profile") c.observation.profileDigest="f".repeat(64);
      if(kind==="unavailable") c.observation.available=false;
      if(kind==="zero-capacity") c.observation.availableCapacity=0;
      if(kind==="zero-quota") c.observation.remainingQuota=0;
      if(kind==="billing") c.observation.billingRoute="paid_api";
      if(kind==="evaluation-expiry") c.evaluations[0]!.expiresAt=new Date(Date.now()-1000).toISOString();
      if(kind!=="malformed-candidate") await db.update(intelligentRoutingContracts).set({candidateEvidenceSnapshot:candidates}).where(eq(intelligentRoutingContracts.id,f.contract.id));
      if(kind==="binding-expiry" || kind==="invalid-binding-expiry") {
        const definition={...f.definition,verifiedUntil:kind==="binding-expiry"?new Date(Date.now()-1000).toISOString():"invalid"};
        await db.update(executionBindings).set({definition}).where(eq(executionBindings.id,f.bindingId));
        await db.update(runExecutionBindings).set({snapshot:{...snapshot,binding:{...snapshot.binding,...definition}}}).where(eq(runExecutionBindings.runId,f.runId));
      }
      if(kind==="future") clock=vi.spyOn(Date,"now").mockReturnValue(Date.parse(c.observation.observedAt)-1);
      if(kind==="effective-expiry") clock=vi.spyOn(Date,"now").mockReturnValue(Date.parse(c.observation.observedAt)+f.contract.requirements.maximumObservationAgeMs);
      try {
        expect((await f.context()).status).toBe(403);
        const r=await request(f.app).put(`/api/issues/${f.attemptId}/coordinator-result`).set("Authorization",`Bearer ${f.token}`).send({body:"Must not persist"});
        expect(r.status).toBe(403);
        expect(await documentService(db).getIssueDocumentByKey(f.attemptId,"coordinator-result")).toBeNull();
      } finally {clock?.mockRestore();}
    });
  }

  it("availability never replaces an acquired contract with a later revision or foreign run",async()=>{
    const f=await activeFixture(),other=await activeFixture();
    const original=await f.context();
    await db.insert(intelligentRoutingContracts).values({...f.contract,id:randomUUID(),revision:f.contract.revision+1,candidateEvidenceSnapshot:[]});
    expect((await f.context()).body.availability).toEqual(original.body.availability);
    const [lease]=await db.select().from(runExecutionBindings).where(eq(runExecutionBindings.runId,f.runId));
    await db.update(runExecutionBindings).set({snapshot:{...lease!.snapshot,routingReceipt:other.acquired.routingReceipt}}).where(eq(runExecutionBindings.runId,f.runId));
    expect((await f.context()).status).toBe(403);
  });

  it("availability bounds explicit expiry before maximum age without changing the structural profile",async()=>{
    const f=await activeFixture();
    const r=await f.context(), a=r.body.availability;
    const observation=(f.contract.candidateEvidenceSnapshot as IntelligentRoutingContractInput["candidates"])[0]!.observation;
    expect(a.validUntil).toBe(new Date(Date.parse(observation.observedAt)+300000).toISOString());
    const candidates=structuredClone(f.contract.candidateEvidenceSnapshot) as IntelligentRoutingContractInput["candidates"];
    candidates[0]!.observation.expiresAt=new Date(Date.parse(observation.observedAt)+120000).toISOString();
    await db.update(intelligentRoutingContracts).set({candidateEvidenceSnapshot:candidates}).where(eq(intelligentRoutingContracts.id,f.contract.id));
    const shortened=await f.context();
    expect(shortened.body.availability.validUntil).toBe(candidates[0]!.observation.expiresAt);
    expect(shortened.body.availability.profileDigest).toBe(a.profileDigest);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.parse(candidates[0]!.observation.expiresAt));
    try{expect((await f.context()).status).toBe(403);}finally{clock.mockRestore();}
  });

  it("permits only current scoped context and replay-safe native result without a master wake", async () => {
    const f = await activeFixture();
    const context = await f.context();
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.source).toBe("Synthetic rough thought");
    expect(JSON.stringify(context.body)).toContain("selected reference marker");
    expect(JSON.stringify(context.body)).not.toMatch(
      /PRIVATE MEMORY|private-home|nativeProfileHome/,
    );
    const result = () =>
      request(f.app)
        .put(`/api/issues/${f.attemptId}/coordinator-result`)
        .set("Authorization", `Bearer ${f.token}`)
        .send({ body: "Bounded synthetic result; check: 2 + 2 = 4" });
    const a = await result(),
      b = await result();
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(
      (
        await request(f.app)
          .put(`/api/issues/${f.attemptId}/coordinator-result`)
          .set("Authorization", `Bearer ${f.token}`)
          .send({ body: "different" })
      ).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId)),
    ).toHaveLength(0);
    const docs = await db
      .select()
      .from(issueDocuments)
      .where(
        and(
          eq(issueDocuments.issueId, f.attemptId),
          eq(issueDocuments.key, "coordinator-result"),
        ),
      );
    expect(docs).toHaveLength(1);
    expect(a.body.lockedAt).toBeTruthy();
    expect(a.body.createdByAgentId).toBe(f.leadId);
    expect(a.body.sourceTrust).toEqual({
      preset: "standard",
      disposition: "promoted",
      sourceIssueId: f.master.id,
    });
    const [revision] = await db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.id, a.body.latestRevisionId));
    expect(revision?.createdByRunId).toBe(f.runId);
    for (const mutate of [
      () =>
        request(f.app)
          .put(`/api/issues/${f.attemptId}/documents/coordinator-result`)
          .send({ format: "markdown", body: "forged" }),
      () =>
        request(f.app)
          .post(
            `/api/issues/${f.attemptId}/documents/coordinator-result/unlock`,
          )
          .send({}),
      () =>
        request(f.app).delete(
          `/api/issues/${f.attemptId}/documents/coordinator-result`,
        ),
    ])
      expect((await mutate()).status).toBe(409);
    expect((await result()).body.id).toBe(a.body.id);
    expect(
      await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, f.companyId),
            eq(activityLog.action, "issue.document_created"),
          ),
        ),
    ).toHaveLength(1);
  });
  it("rejects generic result preseeding and a forged same-body result receipt", async () => {
    const f = await activeFixture();
    expect(
      (
        await request(f.app)
          .put(`/api/issues/${f.attemptId}/documents/coordinator-result`)
          .send({ format: "markdown", body: "forged" })
      ).status,
    ).toBe(409);
    const documentId = randomUUID();
    // Direct fixture corruption cannot become a run-attributed result merely by matching its body.
    await db.insert(documents).values({
      id: documentId,
      companyId: f.companyId,
      latestBody: "forged",
      lockedAt: new Date(),
      createdByUserId: f.userId,
    });
    await db.insert(issueDocuments).values({
      companyId: f.companyId,
      issueId: f.attemptId,
      documentId,
      key: "coordinator-result",
    });
    expect(
      (
        await request(f.app)
          .put(`/api/issues/${f.attemptId}/coordinator-result`)
          .set("Authorization", `Bearer ${f.token}`)
          .send({ body: "forged" })
      ).status,
    ).toBe(409);
  });
  it("keeps a reported terminal attempt pending while its physical lease is held, then settles once", async () => {
    const f = await activeFixture();
    const response = await request(f.app)
      .put(`/api/issues/${f.attemptId}/coordinator-result`)
      .set("Authorization", `Bearer ${f.token}`)
      .send({ body: "Synthetic checked result" });
    expect(response.status).toBe(200);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.runId));
    const service = projectCoordinatorAttemptService(db);
    await expect(service.settle(f.attemptId, f.runId)).resolves.toEqual({
      status: "cleanup_pending",
    });
    const notices = () =>
      db.select().from(issueComments).where(and(
        eq(issueComments.issueId, f.master.id),
        eq(issueComments.createdByRunId, f.runId),
      ));
    expect(await notices()).toEqual([]);
    expect(
      (await db.select().from(issues).where(eq(issues.id, f.attemptId)))[0]!
        .status,
    ).toBe("in_progress");
    await db
      .update(runExecutionBindings)
      .set({ releasedAt: new Date(), releaseReason: "synthetic-reconciled" })
      .where(eq(runExecutionBindings.runId, f.runId));
    await expect(service.settle(f.attemptId, f.runId)).resolves.toEqual({
      status: "in_review",
    });
    await Promise.all([
      service.settle(f.attemptId, f.runId),
      service.settle(f.attemptId, f.runId),
    ]);
    const comments = await notices();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      companyId: f.companyId,
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      createdByRunId: f.runId,
      presentation: {
        kind: "system_notice",
        tone: "info",
        title: "Coordinator result awaiting review",
        detailsDefaultOpen: true,
      },
    });
    expect(comments[0]!.body).toContain(`/issues/${f.attemptId}#document-coordinator-result`);
    expect(comments[0]!.body).toContain("awaiting review");
    expect(comments[0]!.body).toContain("Synthetic checked result");
    await issueService(db).tombstoneComment(comments[0]!.id, { actorType: "user", userId: f.userId });
    await service.settle(f.attemptId, f.runId);
    expect(await notices()).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.master.id),
      eq(activityLog.runId, f.runId),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);
    await expect(service.settle(f.attemptId, f.runId)).resolves.toEqual({
      status: "in_review",
    });
    expect(
      await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, f.attemptId),
            eq(activityLog.action, "project.coordinator_attempt_settled"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId)),
    ).toEqual([]);
  });

  it.each(["failed", "succeeded", "cancelled"])("returns an honest notice for %s without an attributed result", async (runStatus) => {
    const f = await activeFixture();
    await db.update(heartbeatRuns).set({ status: runStatus, finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    if (runStatus === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.attemptId));
    const expectedStatus = runStatus === "cancelled" ? "cancelled" : "blocked";
    await db.update(runExecutionBindings).set({ releasedAt: new Date() }).where(eq(runExecutionBindings.runId, f.runId));
    const service = projectCoordinatorAttemptService(db);
    await expect(service.settle(f.attemptId, f.runId)).resolves.toEqual({ status: expectedStatus });
    const rows = await db.select().from(issueComments).where(and(
      eq(issueComments.issueId, f.master.id),
      eq(issueComments.createdByRunId, f.runId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain(expectedStatus);
    expect(rows[0]!.body).not.toContain("#document-coordinator-result");
  });

  it("publishes a master notice with one database connection", async () => {
    const f = await activeFixture();
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(runExecutionBindings).set({ releasedAt: new Date() }).where(eq(runExecutionBindings.runId, f.runId));
    const one = createDb(temp.connectionString, { maxConnections: 1 });
    const settling = projectCoordinatorAttemptService(one).settle(f.attemptId, f.runId);
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        settling,
        new Promise((resolve) => { timer = setTimeout(() => resolve("pool_deadlock"), 2000); }),
      ]);
      expect(result).toEqual({ status: "blocked" });
    } finally {
      clearTimeout(timer!);
      await one.$client.end({ timeout: 1 });
      await settling.catch(() => {});
    }
  });

  it("settles without publishing a master notice when intake ancestry changed", async () => {
    const f = await activeFixture();
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(runExecutionBindings).set({ releasedAt: new Date() }).where(eq(runExecutionBindings.runId, f.runId));
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, f.intake.id));
    await expect(projectCoordinatorAttemptService(db).settle(f.attemptId, f.runId)).resolves.toEqual({ status: "blocked" });
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.runId))).toEqual([]);
  });

  it("rejects malformed or out-of-policy actual lease selections", async () => {
    const f = await activeFixture();
    const [lease] = await db
      .select()
      .from(runExecutionBindings)
      .where(eq(runExecutionBindings.runId, f.runId));
    for (const selection of [
      { ...lease!.snapshot.selection, model: "unqualified-model" },
      { ...lease!.snapshot.selection, dataClass: "public" as const },
      {
        ...lease!.snapshot.selection,
        requiredCapabilities: ["unqualified-capability"],
      },
      { ...lease!.snapshot.selection, model: undefined },
    ]) {
      await db
        .update(runExecutionBindings)
        .set({
          snapshot: {
            ...lease!.snapshot,
            selection: selection as typeof lease.snapshot.selection,
          },
        })
        .where(eq(runExecutionBindings.runId, f.runId));
      expect((await f.context()).status).toBe(403);
    }
  });
  it("denies all unrelated routes before shortcut handlers and invalidates on terminal run, lease release, pause and source drift", async () => {
    const f = await activeFixture();
    for (const path of [
      `/api/issues/${f.master.id}`,
      "/api/agents/me",
      "/api/secrets",
      "/api/plugins/anything",
      `/api/issues/${f.attemptId}/coordinator-context?extra=1`,
    ]) {
      expect(
        (
          await request(f.app)
            .get(path)
            .set("Authorization", `Bearer ${f.token}`)
        ).status,
      ).toBe(403);
    }
    expect(f.escaped()).toBe(0);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, f.runId));
    expect((await f.context()).status).toBe(403);
    await db
      .update(heartbeatRuns)
      .set({ status: "running" })
      .where(eq(heartbeatRuns.id, f.runId));
    await db
      .update(runExecutionBindings)
      .set({ releasedAt: new Date() })
      .where(eq(runExecutionBindings.runId, f.runId));
    expect((await f.context()).status).toBe(403);
    await db
      .update(runExecutionBindings)
      .set({ releasedAt: null })
      .where(eq(runExecutionBindings.runId, f.runId));
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, f.leadId));
    expect((await f.context()).status).toBe(403);
    await db
      .update(agents)
      .set({ status: "idle" })
      .where(eq(agents.id, f.leadId));
    await db
      .update(issueComments)
      .set({ body: "new authority" })
      .where(eq(issueComments.id, f.comment.id));
    expect((await f.context()).status).toBe(409);
  });
  it("rejects authority drift, revoked user membership and the earlier runtime-tools protocol", async () => {
    const f = await activeFixture();
    const persistentToken = "synthetic-forged-persistent-key";
    await db.insert(agentApiKeys).values({
      companyId: f.companyId,
      agentId: f.leadId,
      responsibleUserId: f.userId,
      name: "Synthetic",
      keyHash: createHash("sha256").update(persistentToken).digest("hex"),
      scopeConfig: {
        kind: "project_coordinator",
        projectId: f.projectId,
        intakeIssueId: f.intake.id,
        attemptIssueId: f.attemptId,
        authorityDigest: "a".repeat(64),
      },
    });
    expect(
      (
        await request(f.app)
          .get(`/api/issues/${f.attemptId}/coordinator-context`)
          .set("Authorization", `Bearer ${persistentToken}`)
      ).status,
    ).toBe(401);

    expect(
      (
        await request(f.app)
          .get("/mcp/runtime-tools")
          .set("Authorization", `Bearer ${f.token}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(f.app)
          .get(`/api/issues/${f.attemptId}/coordinator-context`)
          .set("Authorization", `Bearer ${f.token}`)
          .set("X-Paperclip-Run-Id", randomUUID())
      ).status,
    ).toBe(422);
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    await db
      .update(companyMemberships)
      .set({ status: "inactive" })
      .where(
        and(
          eq(companyMemberships.companyId, f.companyId),
          eq(companyMemberships.principalId, f.userId),
        ),
      );
    expect((await f.context()).status).toBe(403);
    await db
      .update(companyMemberships)
      .set({ status: "active" })
      .where(
        and(
          eq(companyMemberships.companyId, f.companyId),
          eq(companyMemberships.principalId, f.userId),
        ),
      );
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "enforce");
    await db
      .update(companySkillVersions)
      .set({
        fileInventory: [
          { path: "SKILL.md", kind: "skill", content: "changed" },
        ] as never,
      })
      .where(eq(companySkillVersions.id, f.versionId));
    expect((await f.context()).status).toBe(403);
    await db
      .update(companySkillVersions)
      .set({
        fileInventory: [
          {
            path: "SKILL.md",
            kind: "skill",
            content: "selected reference marker",
          },
        ] as never,
      })
      .where(eq(companySkillVersions.id, f.versionId));
    await db
      .update(executionBindings)
      .set({ definition: { ...f.definition, accountKey: "different-account" } })
      .where(eq(executionBindings.id, f.bindingId));
    expect((await f.context()).status).toBe(403);
    await db
      .update(executionBindings)
      .set({ definition: f.definition })
      .where(eq(executionBindings.id, f.bindingId));
    await db.execute(
      sql`UPDATE ${sql.identifier(namespace)}.company_state SET document = jsonb_set(document, '{activePolicyId}', '"other"'::jsonb) WHERE company_id = ${f.companyId}`,
    );
    expect((await f.context()).status).toBe(409);
  });
  it("creates exactly one blocked specialist from an immutable handoff after actual release, retaining distinct workspace and attribution", async () => {
    const f = await specialistFixture();
    expect((await f.context()).body.handoffRoleKey).toBe("independent-review");
    expect((await f.put({ body: "Parent finding", handoff: f.handoff })).status).toBe(200);
    expect((await f.put({ body: "Parent finding", handoff: f.handoff })).status).toBe(200);
    expect(
      (await f.put({ body: "Parent finding", handoff: { ...f.handoff, brief: "Changed" } }))
        .status,
    ).toBe(409);
    expect((await f.put({ body: "Parent finding" })).status).toBe(409);
    expect(await f.finish("succeeded", false)).toEqual({ status: "cleanup_pending" });
    expect(await f.children()).toHaveLength(0);
    await db
      .update(runExecutionBindings)
      .set({ releasedAt: new Date() })
      .where(eq(runExecutionBindings.runId, f.runId));
    await Promise.all([
      projectCoordinatorAttemptService(db).settle(f.attemptId, f.runId),
      projectCoordinatorAttemptService(db).settle(f.attemptId, f.runId),
    ]);
    const [child] = await f.children();
    expect(await f.children()).toHaveLength(1);
    expect(child).toMatchObject({
      status: "blocked",
      assigneeAgentId: f.specialistId,
      parentId: f.attemptId,
      originId: f.attemptId,
      projectWorkspaceId: f.specialistHandoff.projectWorkspaceId,
      checkoutRunId: null,
      executionRunId: null,
      createdByAgentId: f.leadId,
      createdByUserId: null,
    });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.attemptId));
    expect(child!.executionWorkspaceId).not.toBe(parent!.executionWorkspaceId);
    expect(child!.sourceTrust).toEqual(parent!.sourceTrust);
    const authority = await documentService(db).getIssueDocumentByKey(
      child!.id,
      "coordinator-attempt-authority",
    );
    expect(JSON.parse(authority!.body!)).toMatchObject({
      version: 2,
      intakeIssueId: f.intake.id,
      leadAgentId: f.leadId,
      executionAgentId: f.specialistId,
      parent: { attemptIssueId: f.attemptId, runId: f.runId },
    });
    expect(authority!.createdByAgentId).toBe(f.leadId);
    expect(authority!.createdByUserId).toBeNull();
    await expect(
      db.transaction((tx) =>
        assertCoordinatorRunAdmission(tx as never, {
          companyId: f.companyId,
          attemptId: child!.id,
          agentId: f.specialistId,
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await request(f.app)
          .patch(`/api/issues/${child!.id}`)
          .send({ assigneeAgentId: null })
      ).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId)),
    ).toHaveLength(0);
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(f.specialistId, {
      source: "on_demand",
      contextSnapshot: { issueId: child!.id },
      requestedByActorType: "user",
      requestedByActorId: f.userId,
    });
    await heartbeat.drainActiveRunExecutions();
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.nativeIssueId, child!.id)),
    ).toHaveLength(0);
  });

  it("reserves handoff documents and refuses foreign roles before writing either receipt", async () => {
    const f = await specialistFixture();
    expect(
      (
        await request(f.app)
          .put(`/api/issues/${f.attemptId}/documents/coordinator-specialist-handoff`)
          .send({ format: "markdown", body: "forged" })
      ).status,
    ).toBe(409);
    expect(
      (await f.put({ body: "Result", handoff: { ...f.handoff, roleKey: "foreign-role" } }))
        .status,
    ).toBe(403);
    expect(
      await documentService(db).getIssueDocumentByKey(f.attemptId, "coordinator-result"),
    ).toBeNull();
    expect((await f.put({ body: "Result", handoff: f.handoff })).status).toBe(200);
    expect(
      (
        await request(f.app)
          .put(`/api/issues/${f.attemptId}/documents/coordinator-specialist-handoff`)
          .send({ format: "markdown", body: "changed" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(f.app).delete(
          `/api/issues/${f.attemptId}/documents/coordinator-specialist-handoff`,
        )
      ).status,
    ).toBe(409);
  });

  it.each(["failed", "cancelled", "missing-release", "changed-policy", "changed-source"])(
    "does not create a specialist for %s and keeps parent settlement terminal",
    async (condition) => {
      const f = await specialistFixture();
      expect((await f.put({ body: "Result", handoff: f.handoff })).status).toBe(200);
      if (condition === "cancelled")
        await db
          .update(issues)
          .set({ status: "cancelled" })
          .where(eq(issues.id, f.attemptId));
      if (condition === "changed-policy")
        await db
          .update(projects)
          .set({ coordinationPolicyRevision: 2 })
          .where(eq(projects.id, f.projectId));
      if (condition === "changed-source")
        await db
          .update(issueComments)
          .set({ body: "Changed after reporting" })
          .where(eq(issueComments.id, f.comment.id));
      if (condition === "missing-release")
        await db
          .delete(runExecutionBindings)
          .where(eq(runExecutionBindings.runId, f.runId));
      expect(await f.finish(condition === "failed" ? "failed" : "succeeded")).toEqual({
        status:
          condition === "failed"
            ? "blocked"
            : condition === "cancelled"
              ? "cancelled"
              : "in_review",
      });
      expect(await f.children()).toHaveLength(0);
      if (condition.startsWith("changed") || condition === "missing-release") {
        expect(
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.entityId, f.attemptId),
                eq(activityLog.action, "project.coordinator_specialist_unavailable"),
              ),
            ),
        ).toHaveLength(1);
        await db
          .update(projects)
          .set({ coordinationPolicyRevision: 1 })
          .where(eq(projects.id, f.projectId));
        await db
          .update(issueComments)
          .set({ body: f.comment.body })
          .where(eq(issueComments.id, f.comment.id));
        await projectCoordinatorAttemptService(db).settle(f.attemptId, f.runId);
        expect(await f.children()).toHaveLength(0);
      }
    },
  );

  it("runs the specialist on its own qualified role with the lead paused, scoped source/skills, and no grandchildren", async () => {
    const f = await specialistFixture();
    const rootAvailability=(await f.context()).body.availability;
    expect((await f.put({ body: "Parent result marker", handoff: f.handoff })).status).toBe(
      200,
    );
    await f.finish();
    const [child] = await f.children();
    expect(child).toBeDefined();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.leadId));
    const state = await db.transaction((tx) =>
      loadCoordinatorAuthorityForDispatch(tx as never, f.companyId, child!.id),
    );
    expect(state.lead.id).toBe(f.leadId);
    expect(state.executionAgent.id).toBe(f.specialistId);
    expect(state.maxTurns).toBe(1);
    expect(state.taskSource).toContain(f.handoff.brief);
    expect(state.taskSource).toContain("Parent result marker");
    expect(state.skills.map((skill) => skill.key)).toEqual(["specialist-skill"]);
    const routed = await qualifiedFixture(
      {
        ...f,
        leadId: f.specialistId,
        bindingId: f.specialistBindingId,
        policy: { ...f.policy, profiles: [f.specialistHandoff.profile] },
      },
      { attemptId: child!.id, authorityDigest: child!.originFingerprint! },
    );
    const original = getServerAdapter("claude_local");
    let invocations = 0,
      spawns = 0;
    registerServerAdapter({
      ...original,
      execute: async (ctx) => {
        invocations++;
        expect(ctx.agent.id).toBe(f.specialistId);
        expect(ctx.context.coordinatorPrompt).toContain(f.handoff.brief);
        expect(ctx.context.coordinatorPrompt).toContain("Parent result marker");
        const result = await original.execute({
          ...ctx,
          onSpawn: async (meta) => {
            spawns++;
            await ctx.onSpawn?.(meta);
          },
        });
        const claims = verifyLocalAgentJwt(ctx.authToken!);
        expect(claims!.key_scope).toMatchObject({
          intakeIssueId: f.intake.id,
          attemptIssueId: child!.id,
        });
        const actor: AuthorizationActor = {
          type: "agent",
          source: "agent_jwt",
          companyId: f.companyId,
          agentId: f.specialistId,
          runId: ctx.runId,
          onBehalfOfUserId: f.userId,
          keyScope: claims!.key_scope!,
        };
        const context = await projectCoordinatorAttemptService(db).taskEnvelope(
          child!.id,
          actor,
        );
        expect(context).toMatchObject({
          source: state.taskSource,
          handoffRoleKey: null,
          maxTurns: 1,
          availability:{contractId:routed.contract.id,profileDigest:routed.contract.decision.status==="selected"?routed.contract.decision.profileDigest:"invalid",bindingId:f.specialistBindingId},
        });
        expect(routed.contract.id).not.toBe(rootAvailability.contractId);
        expect(digest(f.specialistHandoff.profile)).toBe(routed.contract.decision.status==="selected"?routed.contract.decision.profileDigest:null);
        expect(
          (context as { skills: { key: string }[] }).skills.map((skill) => skill.key),
        ).toEqual(["specialist-skill"]);
        await expect(
          projectCoordinatorAttemptService(db).taskEnvelope(
            child!.id,
            actor,
            "Review",
            f.handoff,
          ),
        ).rejects.toThrow("cannot request");
        await projectCoordinatorAttemptService(db).taskEnvelope(
          child!.id,
          actor,
          "Specialist result",
        );
        return result;
      },
    });
    const heartbeat = heartbeatService(db);
    try {
      await projectCoordinatorAttemptService(db).admit(child!.id, f.actor, routed.start);
      await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.nativeIssueId, child!.id));
      expect(runs.map((run) => ({ status: run.status, error: run.error }))).toEqual([
        { status: "succeeded", error: null },
      ]);
      expect(invocations).toBe(1);
      expect(spawns).toBe(1);
      const [lease] = await db
        .select()
        .from(runExecutionBindings)
        .where(eq(runExecutionBindings.runId, runs[0]!.id));
      expect(lease!.releasedAt).not.toBeNull();
      expect(
        await db.select().from(issues).where(eq(issues.originId, child!.id)),
      ).toHaveLength(0);
      expect(
        (await db.select().from(issues).where(eq(issues.id, child!.id)))[0]!.status,
      ).toBe("in_review");
      expect(
        await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, f.master.id),
              eq(issueComments.createdByRunId, runs[0]!.id),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(original);
    }
  });

  it.each([
    "parent-result",
    "parent-cancelled",
    "lease-held",
    "foreign-role",
    "skill-version",
    "terminated-lead",
  ])("rejects specialist admission after %s drift", async (condition) => {
    const f = await specialistFixture();
    expect((await f.put({ body: "Parent", handoff: f.handoff })).status).toBe(200);
    await f.finish();
    const [child] = await f.children();
    if (condition === "parent-result") {
      const result = await documentService(db).getIssueDocumentByKey(
        f.attemptId,
        "coordinator-result",
      );
      await db
        .update(documents)
        .set({ latestBody: "Replaced" })
        .where(eq(documents.id, result!.id));
    }
    if (condition === "terminated-lead")
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadId));
    if (condition === "parent-cancelled")
      await db
        .update(issues)
        .set({ status: "cancelled" })
        .where(eq(issues.id, f.attemptId));
    if (condition === "lease-held")
      await db
        .update(runExecutionBindings)
        .set({ releasedAt: null })
        .where(eq(runExecutionBindings.runId, f.runId));
    if (condition === "foreign-role") {
      const other = await fixture();
      await db
        .update(agents)
        .set({ companyId: other.companyId })
        .where(eq(agents.id, f.specialistId));
    }
    if (condition === "skill-version")
      await db
        .update(companySkillVersions)
        .set({
          fileInventory: [{ path: "SKILL.md", kind: "skill", content: "Changed" }] as never,
        })
        .where(eq(companySkillVersions.id, f.specialistHandoff.skills[0]!.versionId));
    await expect(
      db.transaction((tx) =>
        loadCoordinatorAuthorityForDispatch(tx as never, f.companyId, child!.id),
      ),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.nativeIssueId, child!.id)),
    ).toHaveLength(0);
  });

  it("refuses a signed attempt token whose original intake lineage differs", async () => {
    const f = await activeFixture();
    const claims = verifyLocalAgentJwt(f.token)!;
    const token = createLocalAgentJwt(
      f.leadId,
      f.companyId,
      "claude_local",
      f.runId,
      f.userId,
      {
        ...claims.key_scope!,
        kind: "project_coordinator",
        projectId: f.projectId,
        attemptIssueId: f.attemptId,
        intakeIssueId: randomUUID(),
        authorityDigest: (claims.key_scope as { authorityDigest: string }).authorityDigest,
      },
    )!;
    expect(
      (
        await request(f.app)
          .get(`/api/issues/${f.attemptId}/coordinator-context`)
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(403);
  });

  it("does not publish a false handoff refusal when an existing specialist is re-settled after policy drift", async () => {
    const f = await specialistFixture();
    expect((await f.put({ body: "Parent", handoff: f.handoff })).status).toBe(200);
    await f.finish();
    const original = await f.children();
    expect(original).toHaveLength(1);
    await db
      .update(projects)
      .set({ coordinationPolicyRevision: 2 })
      .where(eq(projects.id, f.projectId));
    await projectCoordinatorAttemptService(db).settle(f.attemptId, f.runId);
    expect((await f.children()).map((child) => child.id)).toEqual(
      original.map((child) => child.id),
    );
    expect(
      await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, f.attemptId),
            eq(activityLog.action, "project.coordinator_specialist_unavailable"),
          ),
        ),
    ).toHaveLength(0);
  });

});

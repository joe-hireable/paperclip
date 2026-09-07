import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  IntelligentRoutingDecision,
  IntelligentRoutingRequirements,
} from "@paperclipai/shared/intelligent-routing";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// Immutable board decisions. Revisions supersede earlier rows; there is no
// update/delete API. Stored evidence is metadata, never training examples.
export const intelligentRoutingContracts = pgTable(
  "intelligent_routing_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    // Retain historical attribution when an agent is deleted. Company/assignee
    // scope is checked on creation and launch, not granted by this identifier.
    assigneeAgentId: uuid("assignee_agent_id").notNull(),
    revision: integer("revision").notNull(),
    inputDigest: text("input_digest").notNull(),
    requirements: jsonb("requirements")
      .$type<IntelligentRoutingRequirements>()
      .notNull(),
    candidateEvidenceSnapshot: jsonb("candidate_evidence_snapshot")
      .$type<unknown[]>()
      .notNull(),
    decision: jsonb("decision").$type<IntelligentRoutingDecision>().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "intelligent_routing_contracts_issue_company_fk",
    }).onDelete("cascade"),
    issueRevisionUq: uniqueIndex(
      "intelligent_routing_contracts_issue_revision_uq",
    ).on(table.companyId, table.issueId, table.revision),
  }),
);

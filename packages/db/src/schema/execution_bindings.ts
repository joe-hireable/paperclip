import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ExecutionBindingDefinition,
  ExecutionBindingSnapshot,
} from "@paperclipai/shared/execution-bindings";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const executionBindings = pgTable("execution_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  definition: jsonb("definition").$type<ExecutionBindingDefinition>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A reservation survives status changes and server crashes. No expiry can
// make a still-running account available. Definitions/snapshots are retained.
export const runExecutionBindings = pgTable(
  "run_execution_bindings",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => heartbeatRuns.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => executionBindings.id),
    accountKey: text("account_key").notNull(),
    snapshot: jsonb("snapshot").$type<ExecutionBindingSnapshot>().notNull(),
    ownerId: text("owner_id").notNull(),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processHistory: jsonb("process_history")
      .$type<Array<{ pid: number; processGroupId: number | null }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (table) => ({
    heldAccount: uniqueIndex("run_execution_bindings_held_account_uniq")
      .on(table.companyId, table.accountKey)
      .where(sql`${table.releasedAt} is null`),
  }),
);

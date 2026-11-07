import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  closeRegisteredClients,
  ensurePostgresDatabase,
  inspectMigrations,
} from "./client.js";
import {
  JOE_BACKUP_MIGRATION_REMAP,
  PLUGIN_SHARED_OPERATIONS_SCHEMA,
  liveSwitchMigrateExistingDatabase,
} from "./live-switch.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const LIVE_SWITCH_TEST_TIMEOUT_MS = 300_000;

const support = await getEmbeddedPostgresTestSupport();

async function migrationHash(fileName: string) {
  const content = await readFile(new URL(`./migrations/${fileName}`, import.meta.url));
  return createHash("sha256").update(content).digest("hex");
}

async function publicSchema(sql: postgres.Sql) {
  return {
    columns: await sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `,
    indexes: await sql`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `,
    constraints: await sql`
      SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname, k.conname
    `,
  };
}

async function seedBackupDatabase(sql: postgres.Sql) {
  const companyId = randomUUID();
  const issueId = randomUUID();
  await sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${companyId}, 'Live switch seed', 'LSW')
  `;
  await sql`
    INSERT INTO issues (id, company_id, title)
    VALUES (${issueId}, ${companyId}, 'Retained after remap')
  `;
  await sql.unsafe(`CREATE SCHEMA ${PLUGIN_SHARED_OPERATIONS_SCHEMA}`);
  await sql.unsafe(
    await readFile(
      new URL("../../plugins/plugin-shared-operations/migrations/001_company_state.sql", import.meta.url),
      "utf8",
    ),
  );
  await sql.unsafe(
    `INSERT INTO ${PLUGIN_SHARED_OPERATIONS_SCHEMA}.company_state
      (company_id, revision, document)
     VALUES ('${companyId}', 7, '{"retained":true}'::jsonb)`,
  );
  return { companyId, issueId };
}

(support.supported ? describe : describe.skip)("live-switch backup schema upgrade", () => {
  it(
    "remaps Joe 0240–0247 by hash and name, skips an existing plugin schema, and is idempotent",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-live-switch-");
      const source = postgres(database.connectionString, { max: 1, onnotice() {} });
      const directory = await mkdtemp(join(tmpdir(), "paperclip-live-switch-backup-"));
      const hashDbName = `live_switch_hash_${randomUUID().replaceAll("-", "")}`;
      const nameDbName = `live_switch_name_${randomUUID().replaceAll("-", "")}`;
      const hashUrl = new URL(database.connectionString);
      hashUrl.pathname = `/${hashDbName}`;
      const nameUrl = new URL(database.connectionString);
      nameUrl.pathname = `/${nameDbName}`;
      let hashSql: postgres.Sql | null = null;
      let nameSql: postgres.Sql | null = null;
      try {
        const journal = JSON.parse(
          await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
        ) as {
          entries: Array<{
            idx: number;
            tag: string;
            when: number;
            version: string;
            breakpoints: boolean;
          }>;
        };
        const prefix = journal.entries.filter((entry) => entry.idx < 240);
        const joeEntries = JOE_BACKUP_MIGRATION_REMAP.map(([from, to], offset) => {
          const current = journal.entries.find((entry) => `${entry.tag}.sql` === to);
          if (!current) throw new Error(`Missing current journal entry for ${to}`);
          return {
            ...current,
            idx: 240 + offset,
            tag: from.replace(/\.sql$/, ""),
          };
        });
        const priorEntries = [...prefix, ...joeEntries];
        await mkdir(join(directory, "meta"));
        for (const entry of prefix) {
          await writeFile(
            join(directory, `${entry.tag}.sql`),
            await readFile(new URL(`./migrations/${entry.tag}.sql`, import.meta.url)),
          );
        }
        for (const [from, to] of JOE_BACKUP_MIGRATION_REMAP) {
          await writeFile(
            join(directory, from),
            await readFile(new URL(`./migrations/${to}`, import.meta.url)),
          );
        }
        await writeFile(
          join(directory, "meta/_journal.json"),
          JSON.stringify({ ...journal, entries: priorEntries }),
        );

        expect(await ensurePostgresDatabase(database.connectionString, hashDbName)).toBe("created");
        hashSql = postgres(hashUrl.href, { max: 1, onnotice() {} });
        await migrate(drizzle(hashSql), { migrationsFolder: directory });
        const seed = await seedBackupDatabase(hashSql);
        const hashes = await Promise.all(
          JOE_BACKUP_MIGRATION_REMAP.map(async ([, to]) => [to, await migrationHash(to)] as const),
        );
        const historyBefore = await hashSql`
          SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id
        `;
        for (const [, hash] of hashes) {
          expect(historyBefore.filter((row) => row.hash === hash)).toHaveLength(1);
        }

        await hashSql.end({ timeout: 5 });
        hashSql = null;
        const admin = postgres(database.connectionString, { max: 1, onnotice() {} });
        try {
          await admin.unsafe(`CREATE DATABASE "${nameDbName}" TEMPLATE "${hashDbName}"`);
        } finally {
          await admin.end({ timeout: 5 });
        }

        hashSql = postgres(hashUrl.href, { max: 1, onnotice() {} });
        nameSql = postgres(nameUrl.href, { max: 1, onnotice() {} });
        const prefixHashes = new Map<string, string>();
        for (const entry of prefix) {
          prefixHashes.set(await migrationHash(`${entry.tag}.sql`), `${entry.tag}.sql`);
        }
        await nameSql.unsafe(
          `ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN name text`,
        );
        const nameRows = await nameSql<{ id: number; hash: string }[]>`
          SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id
        `;
        for (const row of nameRows) {
          const joe = hashes.find(([, hash]) => hash === row.hash);
          const fileName = joe
            ? JOE_BACKUP_MIGRATION_REMAP.find(([, to]) => to === joe[0])![0]
            : prefixHashes.get(row.hash);
          if (!fileName) throw new Error(`Could not map hash ${row.hash} to a backup filename`);
          await nameSql.unsafe(
            `UPDATE drizzle.__drizzle_migrations SET name = '${fileName}' WHERE id = ${row.id}`,
          );
        }

        const hashInspect = await inspectMigrations(hashUrl.href);
        const nameInspect = await inspectMigrations(nameUrl.href);
        expect(hashInspect.status).toBe("needsMigrations");
        expect(nameInspect.status).toBe("needsMigrations");
        expect(hashInspect.status === "needsMigrations" ? hashInspect.pendingMigrations : []).not.toEqual(
          expect.arrayContaining(JOE_BACKUP_MIGRATION_REMAP.map(([, to]) => to)),
        );
        expect(nameInspect.status === "needsMigrations" ? nameInspect.pendingMigrations : []).toEqual(
          expect.arrayContaining(JOE_BACKUP_MIGRATION_REMAP.map(([, to]) => to)),
        );

        const hashFirst = await liveSwitchMigrateExistingDatabase(hashUrl.href);
        const nameFirst = await liveSwitchMigrateExistingDatabase(nameUrl.href);
        expect(hashFirst.upToDate).toBe(true);
        expect(nameFirst.upToDate).toBe(true);
        expect(hashFirst.plugin).toEqual({ schemaExists: true, skipped: true, applied: false });
        expect(nameFirst.plugin).toEqual({ schemaExists: true, skipped: true, applied: false });
        expect(hashFirst.remapped.every((row) => row.action === "hash-only")).toBe(true);
        expect(nameFirst.remapped.every((row) => row.action === "renamed")).toBe(true);
        expect(hashFirst.pendingBefore).not.toEqual(
          expect.arrayContaining(JOE_BACKUP_MIGRATION_REMAP.map(([, to]) => to)),
        );
        expect(nameFirst.pendingBefore).not.toEqual(
          expect.arrayContaining(JOE_BACKUP_MIGRATION_REMAP.map(([, to]) => to)),
        );
        expect(hashFirst.pendingBefore[0]).toBe("0240_pink_fantastic_four.sql");

        for (const sql of [hashSql, nameSql]) {
          expect(
            await sql`SELECT name FROM companies WHERE id = ${seed.companyId}`,
          ).toEqual([{ name: "Live switch seed" }]);
          expect(
            await sql`SELECT title FROM issues WHERE id = ${seed.issueId}`,
          ).toEqual([{ title: "Retained after remap" }]);
          expect(
            await sql.unsafe(
              `SELECT revision, document FROM ${PLUGIN_SHARED_OPERATIONS_SCHEMA}.company_state WHERE company_id = '${seed.companyId}'`,
            ),
          ).toEqual([{ revision: 7, document: { retained: true } }]);
        }

        const nameHistory = await nameSql`
          SELECT name, hash FROM drizzle.__drizzle_migrations ORDER BY id
        `;
        for (const [from, to] of JOE_BACKUP_MIGRATION_REMAP) {
          expect(nameHistory.filter((row) => row.name === from)).toHaveLength(0);
          expect(nameHistory.filter((row) => row.name === to)).toHaveLength(1);
        }

        const hashSecond = await liveSwitchMigrateExistingDatabase(hashUrl.href);
        const nameSecond = await liveSwitchMigrateExistingDatabase(nameUrl.href);
        expect(hashSecond.pendingBefore).toEqual([]);
        expect(nameSecond.pendingBefore).toEqual([]);
        expect(hashSecond.remapped.every((row) => row.action === "hash-only")).toBe(true);
        expect(nameSecond.remapped.every((row) => row.action === "already-current")).toBe(true);
        expect(hashSecond.plugin.skipped).toBe(true);
        expect(nameSecond.plugin.skipped).toBe(true);

        expect((await inspectMigrations(hashUrl.href)).status).toBe("upToDate");
        expect((await inspectMigrations(nameUrl.href)).status).toBe("upToDate");
        expect(await publicSchema(hashSql)).toEqual(await publicSchema(source));
        expect(await publicSchema(nameSql)).toEqual(await publicSchema(source));
      } finally {
        await hashSql?.end({ timeout: 5 });
        await nameSql?.end({ timeout: 5 });
        await source.end({ timeout: 5 });
        await closeRegisteredClients(database.connectionString);
        await rm(directory, { recursive: true, force: true });
        await database.cleanup();
      }
    },
    LIVE_SWITCH_TEST_TIMEOUT_MS,
  );
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";

/**
 * Joe's backup-branch journal numbered these files 0240–0247. Upstream later
 * occupied 0240–0437, so the same SQL now lives at 0438–0445. Drizzle keys
 * history by SHA-256 of the file bytes; those hashes must be treated as
 * already applied and must never re-run.
 */
export const JOE_BACKUP_MIGRATION_REMAP = [
  ["0240_gigantic_tattoo.sql", "0438_gigantic_tattoo.sql"],
  ["0241_hesitant_blur.sql", "0439_hesitant_blur.sql"],
  ["0242_mysterious_squadron_sinister.sql", "0440_mysterious_squadron_sinister.sql"],
  ["0243_complex_sunfire.sql", "0441_complex_sunfire.sql"],
  ["0244_equal_wrecking_crew.sql", "0442_equal_wrecking_crew.sql"],
  ["0245_parallel_norrin_radd.sql", "0443_parallel_norrin_radd.sql"],
  ["0246_graceful_doorman.sql", "0444_graceful_doorman.sql"],
  ["0247_remarkable_spyke.sql", "0445_remarkable_spyke.sql"],
] as const;

export const PLUGIN_SHARED_OPERATIONS_SCHEMA = "plugin_shared_operations_6f6f8a1ee6";

const PLUGIN_MIGRATION_URL = new URL(
  "../../plugins/plugin-shared-operations/migrations/001_company_state.sql",
  import.meta.url,
);

const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";

export type LiveSwitchRemapAction = "renamed" | "already-current" | "hash-only" | "absent";

export type LiveSwitchRemapRow = {
  from: string;
  to: string;
  hash: string;
  action: LiveSwitchRemapAction;
};

export type LiveSwitchPluginResult = {
  schemaExists: boolean;
  skipped: boolean;
  applied: boolean;
};

export type LiveSwitchResult = {
  remapped: LiveSwitchRemapRow[];
  pendingBefore: string[];
  pendingAfter: string[];
  plugin: LiveSwitchPluginResult;
  upToDate: boolean;
};

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function hashMigrationFile(fileName: string): Promise<string> {
  const content = await readFile(new URL(`./migrations/${fileName}`, import.meta.url));
  return createHash("sha256").update(content).digest("hex");
}

async function discoverMigrationTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ schema: string; columns: Set<string> } | null> {
  const tables = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;
  if (tables.length === 0) return null;
  const schema =
    tables.find((row) => row.schemaName === "drizzle")?.schemaName ??
    tables.find((row) => row.schemaName === "public")?.schemaName ??
    tables[0]!.schemaName;
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = '${schema.replaceAll("'", "''")}'
       AND table_name = '${DRIZZLE_MIGRATIONS_TABLE}'`,
  );
  return { schema, columns: new Set(columns.map((column) => column.column_name)) };
}

async function remapJoeBackupMigrationHistory(
  sql: ReturnType<typeof postgres>,
): Promise<LiveSwitchRemapRow[]> {
  const table = await discoverMigrationTable(sql);
  const remapped: LiveSwitchRemapRow[] = [];
  for (const [from, to] of JOE_BACKUP_MIGRATION_REMAP) {
    const hash = await hashMigrationFile(to);
    if (!table) {
      remapped.push({ from, to, hash, action: "absent" });
      continue;
    }
    const qualified = `${quoteIdent(table.schema)}.${quoteIdent(DRIZZLE_MIGRATIONS_TABLE)}`;
    const byHash = table.columns.has("hash")
      ? await sql.unsafe<{ hash: string; name?: string | null }[]>(
          `SELECT ${table.columns.has("name") ? "hash, name" : "hash"} FROM ${qualified} WHERE hash = '${hash}'`,
        )
      : [];
    if (byHash.length === 0) {
      remapped.push({ from, to, hash, action: "absent" });
      continue;
    }
    if (!table.columns.has("name")) {
      remapped.push({ from, to, hash, action: "hash-only" });
      continue;
    }
    const names = [...new Set(byHash.map((row) => row.name).filter((name): name is string => Boolean(name)))];
    if (names.length === 1 && names[0] === to) {
      remapped.push({ from, to, hash, action: "already-current" });
      continue;
    }
    await sql.unsafe(
      `UPDATE ${qualified} SET name = '${to.replaceAll("'", "''")}' WHERE hash = '${hash}'`,
    );
    remapped.push({ from, to, hash, action: "renamed" });
  }
  return remapped;
}

async function assertJoeSqlWillNotReapply(
  url: string,
  remapped: LiveSwitchRemapRow[],
): Promise<void> {
  const state = await inspectMigrations(url);
  const pending = state.status === "upToDate" ? [] : state.pendingMigrations;
  const present = new Set(
    remapped.filter((row) => row.action !== "absent").map((row) => row.to),
  );
  const wouldReplay = pending.filter((file) => present.has(file));
  if (wouldReplay.length > 0) {
    throw new Error(
      `Refusing to re-apply remapped Joe migrations: ${wouldReplay.join(", ")}`,
    );
  }
}

async function pluginSchemaExists(sql: ReturnType<typeof postgres>): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM pg_namespace WHERE nspname = ${PLUGIN_SHARED_OPERATIONS_SCHEMA} LIMIT 1
  `;
  return rows.length > 0;
}

async function applyPluginSchemaIfMissing(
  sql: ReturnType<typeof postgres>,
): Promise<LiveSwitchPluginResult> {
  if (await pluginSchemaExists(sql)) {
    return { schemaExists: true, skipped: true, applied: false };
  }
  const pluginSql = await readFile(fileURLToPath(PLUGIN_MIGRATION_URL), "utf8");
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(PLUGIN_SHARED_OPERATIONS_SCHEMA)}`);
  await sql.unsafe(pluginSql);
  return { schemaExists: false, skipped: false, applied: true };
}

/**
 * Upgrade a database that is still on the backup-branch schema (shared
 * 0000–0239 plus Joe 0240–0247) onto this head. Idempotent: a second call is
 * a no-op once the journal is current.
 */
export async function liveSwitchMigrateExistingDatabase(
  url: string,
): Promise<LiveSwitchResult> {
  const sql = postgres(url, { max: 1, onnotice() {} });
  try {
    const remapped = await remapJoeBackupMigrationHistory(sql);
    await assertJoeSqlWillNotReapply(url, remapped);
    const before = await inspectMigrations(url);
    const pendingBefore = before.status === "upToDate" ? [] : before.pendingMigrations;
    if (pendingBefore.length > 0) {
      await applyPendingMigrations(url);
    }
    const after = await inspectMigrations(url);
    if (after.status !== "upToDate") {
      throw new Error(
        `Live-switch migrations incomplete: ${after.pendingMigrations.join(", ")}`,
      );
    }
    const plugin = await applyPluginSchemaIfMissing(sql);
    return {
      remapped,
      pendingBefore,
      pendingAfter: [],
      plugin,
      upToDate: true,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

import { liveSwitchMigrateExistingDatabase } from "./live-switch.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();
  console.log(`Live-switch migrating database via ${resolved.source}`);
  try {
    const result = await liveSwitchMigrateExistingDatabase(resolved.connectionString);
    const renamed = result.remapped.filter((row) => row.action === "renamed").length;
    const hashOnly = result.remapped.filter((row) => row.action === "hash-only").length;
    const already = result.remapped.filter((row) => row.action === "already-current").length;
    const absent = result.remapped.filter((row) => row.action === "absent").length;
    console.log(
      `Joe 0240–0247 remap: renamed=${renamed} hash-only=${hashOnly} already-current=${already} absent=${absent}`,
    );
    if (result.pendingBefore.length === 0) {
      console.log("No pending core migrations");
    } else {
      console.log(`Applied ${result.pendingBefore.length} pending core migration(s)`);
    }
    if (result.plugin.skipped) {
      console.log(
        `Plugin schema ${result.plugin.schemaExists ? "exists" : "missing"}: skipped 001_company_state.sql`,
      );
    } else if (result.plugin.applied) {
      console.log("Plugin schema was missing: applied 001_company_state.sql");
    }
    console.log("Live-switch complete");
  } finally {
    await resolved.stop();
  }
}

await main();

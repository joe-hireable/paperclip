# Live-switch: existing database at the backup schema

Use this when a running Paperclip instance is still on
`backup/pre-upstream-rebase-20261106` (Joe's 0240–0247 journal) and you are
replacing the process with this ported head. The core SQL for Joe's files did
not change; only their journal numbers moved.

Do not force-push. Do not generate a new core migration for this remap.

## What the backup journal looks like

Backup `_journal.json` ends:

| Backup tag | Content-identical head tag |
| --- | --- |
| `0240_gigantic_tattoo` | `0438_gigantic_tattoo` |
| `0241_hesitant_blur` | `0439_hesitant_blur` |
| `0242_mysterious_squadron_sinister` | `0440_mysterious_squadron_sinister` |
| `0243_complex_sunfire` | `0441_complex_sunfire` |
| `0244_equal_wrecking_crew` | `0442_equal_wrecking_crew` |
| `0245_parallel_norrin_radd` | `0443_parallel_norrin_radd` |
| `0246_graceful_doorman` | `0444_graceful_doorman` |
| `0247_remarkable_spyke` | `0445_remarkable_spyke` |

Drizzle stores `sha256(file bytes)` in `drizzle.__drizzle_migrations`. Those
eight hashes are already present on a backup-schema database. Head also has
independent upstream files `0240_pink_fantastic_four` … `0437_*`. Those are
the only SQL that must run.

## Why a plain `pnpm db:migrate` is not enough

- **Hash-only journals** (default: columns `id`, `hash`, `created_at`):
  `inspectMigrations` maps the stored hashes onto `0438`–`0445` and will not
  re-apply them. Pending files are upstream `0240`–`0437`. This path is safe
  with `applyPendingMigrations`.
- **Name-column journals** (a `name` column holding `0240_gigantic_tattoo.sql`
  and friends): history is keyed by filename. Head no longer has those
  filenames, so `0438`–`0445` look pending and **would re-apply Joe's SQL**.
  The live-switch script rewrites those eight names to the `0438`–`0445`
  filenames when the hash already matches, then migrates.

The script refuses to apply any of `0438`–`0445` when their hashes are already
in the journal.

## Plugin schema

Plugin `plugin-shared-operations` owns schema
`plugin_shared_operations_6f6f8a1ee6` and `001_company_state.sql`. A live
instance that already installed the plugin has that schema.

- If the schema **exists**: skip the plugin SQL. Do not `CREATE TABLE` again.
- If the schema **does not exist**: create it and apply `001_company_state.sql`.

The script is idempotent. A second run remaps nothing new, applies no core
SQL, and skips the plugin.

## Command

Take a backup first (`pnpm db:backup` or the instance backup path). Then:

```sh
DATABASE_URL=postgres://… pnpm --filter @paperclipai/db live-switch
```

The CLI uses the same connection resolver as `pnpm db:migrate` (`DATABASE_URL`,
or the embedded dev database when unset).

Library entry: `liveSwitchMigrateExistingDatabase(connectionString)` in
`@paperclipai/db`.

## After the switch

1. Journal status is `upToDate` against this head.
2. Joe's eight hashes appear once, under the `0438`–`0445` names when a name
   column exists.
3. Application rows (companies, issues, heartbeats, plugin `company_state`)
   are unchanged by the remap.
4. Start the new process on this head. Do not re-run Joe 0240–0247 by copying
   SQL from the backup branch into `packages/db/src/migrations/`.

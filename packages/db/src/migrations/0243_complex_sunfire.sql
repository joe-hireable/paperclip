CREATE UNIQUE INDEX "run_execution_bindings_held_global_account_uniq" ON "run_execution_bindings" USING btree ("account_key") WHERE "run_execution_bindings"."released_at" is null;
--> statement-breakpoint
DROP INDEX "run_execution_bindings_held_account_uniq";--> statement-breakpoint
ALTER TABLE "execution_bindings" ADD COLUMN "profile_roots" jsonb;

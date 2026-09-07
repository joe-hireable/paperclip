CREATE TABLE "execution_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_execution_bindings" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"account_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"owner_id" text NOT NULL,
	"process_pid" integer,
	"process_group_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
ALTER TABLE "execution_bindings" ADD CONSTRAINT "execution_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_bindings" ADD CONSTRAINT "run_execution_bindings_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_bindings" ADD CONSTRAINT "run_execution_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_bindings" ADD CONSTRAINT "run_execution_bindings_binding_id_execution_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."execution_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_execution_bindings_held_account_uniq" ON "run_execution_bindings" USING btree ("company_id","account_key") WHERE "run_execution_bindings"."released_at" is null;
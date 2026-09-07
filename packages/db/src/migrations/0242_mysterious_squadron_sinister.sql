CREATE TABLE "intelligent_routing_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"assignee_agent_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"input_digest" text NOT NULL,
	"requirements" jsonb NOT NULL,
	"candidate_evidence_snapshot" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intelligent_routing_contracts" ADD CONSTRAINT "intelligent_routing_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligent_routing_contracts" ADD CONSTRAINT "intelligent_routing_contracts_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intelligent_routing_contracts_issue_revision_uq" ON "intelligent_routing_contracts" USING btree ("company_id","issue_id","revision");
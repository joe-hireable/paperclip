ALTER TABLE "projects" ADD COLUMN "coordination_policy" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "coordination_policy_revision" integer DEFAULT 0 NOT NULL;
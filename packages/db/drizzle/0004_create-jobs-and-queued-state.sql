ALTER TYPE "public"."reminder_state" ADD VALUE 'queued' BEFORE 'sent';--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dead_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "jobs_open_run_at_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."done_at" IS NULL;
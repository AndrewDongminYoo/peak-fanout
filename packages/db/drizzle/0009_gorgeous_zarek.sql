ALTER TYPE "public"."reminder_state" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "local_date" date;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "scheduled_timezone" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_local_date_unique" UNIQUE("user_id","local_date");
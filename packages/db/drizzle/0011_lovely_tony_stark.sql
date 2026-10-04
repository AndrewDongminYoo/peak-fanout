CREATE TYPE "public"."push_receipt_status" AS ENUM('pending', 'ok', 'error', 'expired');--> statement-breakpoint
CREATE TABLE "push_receipts" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"push_token_id" uuid,
	"registration_user_id" uuid,
	"registration_created_at" timestamp with time zone,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() + interval '15 minutes' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" "push_receipt_status" DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"last_error" text,
	"checked_at" timestamp with time zone,
	CONSTRAINT "push_receipts_attempts_nonnegative" CHECK ("push_receipts"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "push_receipts" ADD CONSTRAINT "push_receipts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_receipts" ADD CONSTRAINT "push_receipts_push_token_id_push_tokens_id_fk" FOREIGN KEY ("push_token_id") REFERENCES "public"."push_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_receipts_pending_check_idx" ON "push_receipts" USING btree ("next_check_at","delivery_id") WHERE "push_receipts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "push_receipts_push_token_idx" ON "push_receipts" USING btree ("push_token_id");
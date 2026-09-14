CREATE TABLE "expressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"lang" text NOT NULL,
	"text" text NOT NULL,
	"translation" text NOT NULL,
	"level" integer NOT NULL,
	CONSTRAINT "expressions_position_unique" UNIQUE("position")
);

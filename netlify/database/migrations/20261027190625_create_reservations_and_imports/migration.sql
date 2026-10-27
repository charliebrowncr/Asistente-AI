CREATE TABLE "imports" (
	"id" serial PRIMARY KEY,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"imported_by" text,
	"reservation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" serial PRIMARY KEY,
	"external_id" text NOT NULL UNIQUE,
	"codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"guest_name" text NOT NULL,
	"guest_email" text,
	"house_name" text DEFAULT '' NOT NULL,
	"villa" text DEFAULT '' NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"nights" integer DEFAULT 0 NOT NULL,
	"guests" integer DEFAULT 0 NOT NULL,
	"adults" integer DEFAULT 0 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total" numeric(12,2),
	"import_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reservations_arrival_idx" ON "reservations" ("arrival");--> statement-breakpoint
CREATE INDEX "reservations_codes_idx" ON "reservations" USING gin ("codes");
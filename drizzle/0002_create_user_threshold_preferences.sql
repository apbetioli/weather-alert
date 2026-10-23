CREATE TABLE IF NOT EXISTS "user_threshold_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"rain_enabled" boolean DEFAULT true NOT NULL,
	"rain_threshold_mm" numeric(5, 2) DEFAULT '5.00' NOT NULL,
	"snow_enabled" boolean DEFAULT true NOT NULL,
	"snow_threshold_cm" numeric(5, 2) DEFAULT '2.00' NOT NULL,
	"wind_enabled" boolean DEFAULT true NOT NULL,
	"wind_threshold_kmh" numeric(5, 1) DEFAULT '60.0' NOT NULL,
	"frost_enabled" boolean DEFAULT true NOT NULL,
	"frost_threshold_c" numeric(4, 1) DEFAULT '0.0' NOT NULL,
	"heat_enabled" boolean DEFAULT true NOT NULL,
	"heat_threshold_c" numeric(4, 1) DEFAULT '35.0' NOT NULL,
	"hail_mode" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_threshold_preferences_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_threshold_chat_id" ON "user_threshold_preferences" USING btree ("telegram_chat_id");

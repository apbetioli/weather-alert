CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_alert_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"location_name" varchar(100) DEFAULT 'Monitored Location' NOT NULL,
	"location" geography(Point, 4326) NOT NULL,
	"h3_index" varchar(15) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_alert_zones_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_zones_h3_index" ON "user_alert_zones" USING btree ("h3_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_zones_location" ON "user_alert_zones" USING GIST ("location");
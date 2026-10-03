CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS "user_alert_zones" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "telegram_chat_id" bigint NOT NULL UNIQUE,
  "location_name" varchar(100) DEFAULT 'Monitored Location' NOT NULL,
  "location" geography(Point, 4326) NOT NULL,
  "h3_res7" varchar(15) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- GiST spatial index for spherical geography operations
CREATE INDEX IF NOT EXISTS "idx_user_zones_location" ON "user_alert_zones" USING GIST ("location");

-- Standard B-Tree index for lightning-fast Uber H3 hexagon lookups
CREATE INDEX IF NOT EXISTS "idx_user_zones_h3_res7" ON "user_alert_zones" ("h3_res7");

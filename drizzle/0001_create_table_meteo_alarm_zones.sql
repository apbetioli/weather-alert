CREATE TABLE "meteoalarm_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"emma_id" varchar(32) NOT NULL,
	"country_code" varchar(4) NOT NULL,
	"name" varchar(255) NOT NULL,
	"geometry" geometry(MultiPolygon, 4326) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meteoalarm_zones_emma_id_unique" UNIQUE("emma_id")
);
--> statement-breakpoint
CREATE INDEX "idx_meteoalarm_zones_geom" ON "meteoalarm_zones" USING gist ("geometry");
import { pgTable, serial, varchar, bigint, timestamp, uuid, customType, index } from 'drizzle-orm/pg-core';

// Custom Drizzle type mapping for PostGIS Geography(Point, 4326)
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

export const geometryMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(MultiPolygon, 4326)';
  },
});

export const userAlertZones = pgTable(
  'user_alert_zones',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').defaultRandom().notNull(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull().unique(),
    locationName: varchar('location_name', { length: 100 }).default('Monitored Location').notNull(),
    
    // PostGIS spherical geography Point (SRID 4326: WGS 84)
    location: geographyPoint('location').notNull(),
    
    // Uber H3 cell index (configured resolution)
    h3Index: varchar('h3_index', { length: 15 }).notNull(),


    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Standard B-Tree index for sub-millisecond H3 lookups
    index('idx_user_zones_h3_index').on(table.h3Index),
    // GiST index on location is managed in SQL migration for spherical operations
  ]
);

export const meteoalarmZones = pgTable('meteoalarm_zones', {
  id: serial('id').primaryKey(),
  emmaId: varchar('emma_id', { length: 32 }).notNull().unique(),
  countryCode: varchar('country_code', { length: 4 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  geometry: geometryMultiPolygon('geometry').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_meteoalarm_zones_geom').using('gist', table.geometry)
]);

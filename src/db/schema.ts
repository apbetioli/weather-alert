import { pgTable, serial, varchar, bigint, timestamp, uuid, customType, index, boolean, numeric, smallint } from 'drizzle-orm/pg-core';

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

export const userThresholdPreferences = pgTable(
  'user_threshold_preferences',
  {
    id: serial('id').primaryKey(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull().unique(),

    // Rainfall (mm accumulation in rolling 24h)
    rainEnabled: boolean('rain_enabled').default(true).notNull(),
    rainThresholdMm: numeric('rain_threshold_mm', { precision: 5, scale: 2 }).default('5.00').notNull(),

    // Snowfall (cm accumulation in rolling 24h)
    snowEnabled: boolean('snow_enabled').default(true).notNull(),
    snowThresholdCm: numeric('snow_threshold_cm', { precision: 5, scale: 2 }).default('2.00').notNull(),

    // Wind gusts (km/h max in rolling 24h)
    windEnabled: boolean('wind_enabled').default(true).notNull(),
    windThresholdKmh: numeric('wind_threshold_kmh', { precision: 5, scale: 1 }).default('60.0').notNull(),

    // Frost / Freezing minimum temperature (°C in rolling 24h)
    frostEnabled: boolean('frost_enabled').default(true).notNull(),
    frostThresholdC: numeric('frost_threshold_c', { precision: 4, scale: 1 }).default('0.0').notNull(),

    // Extreme Heat maximum temperature (°C in rolling 24h)
    heatEnabled: boolean('heat_enabled').default(true).notNull(),
    heatThresholdC: numeric('heat_threshold_c', { precision: 4, scale: 1 }).default('35.0').notNull(),

    // Hail risk mode: 0 = Off, 1 = Any Risk, 2 = Severe Only
    hailMode: smallint('hail_mode').default(1).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_user_threshold_chat_id').on(table.telegramChatId),
  ]
);

export type UserThresholdPreferences = typeof userThresholdPreferences.$inferSelect;
export type NewUserThresholdPreferences = typeof userThresholdPreferences.$inferInsert;


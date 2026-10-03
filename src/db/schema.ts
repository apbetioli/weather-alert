import { pgTable, serial, varchar, bigint, timestamp, uuid, customType, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom Drizzle type mapping for PostGIS Geography(Point, 4326)
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point, 4326)';
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
    
    // Uber H3 Resolution 7 cell index (e.g. "871f9124fffffff", ~5.16 km² area, ~1.22 km edge length)
    h3Res7: varchar('h3_res7', { length: 15 }).notNull(),
    
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Standard B-Tree index for sub-millisecond H3 lookups
    index('idx_user_zones_h3_res7').on(table.h3Res7),
    // GiST index on location is managed in SQL migration for spherical operations
  ]
);

export type UserAlertZone = typeof userAlertZones.$inferSelect;
export type NewUserAlertZone = typeof userAlertZones.$inferInsert;

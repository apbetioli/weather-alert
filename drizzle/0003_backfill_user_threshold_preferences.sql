INSERT INTO "user_threshold_preferences" ("telegram_chat_id")
SELECT "telegram_chat_id" FROM "user_alert_zones"
ON CONFLICT ("telegram_chat_id") DO NOTHING;

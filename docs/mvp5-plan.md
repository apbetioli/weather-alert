# Implementation Plan — Weather Alert App (MVP 5: Multi-Channel Delivery & Production Hardening)

## Goal: MVP 5 Multi-Channel Notification, Quiet Hours & High Availability

Following the live radar and authoritative warning boundaries in MVP 4, **MVP 5** prepares the Weather Alert system for production scaling and broad consumer availability:

1. **Multi-Channel Dispatch:**
   - Extend BullMQ notification workers to support **WhatsApp Cloud API** and **Web Push (PWA)** in addition to Telegram.
   - Channel routing preference per user (Telegram, WhatsApp, or Web Push).
2. **Quiet Hours & Severity Overrides:**
   - Allow users to set quiet hours (e.g. 23:00 to 07:00).
   - "Life Safety Override": Extreme / Red alerts (destructive hail, supercells) bypass quiet hours, while moderate alerts are held until morning.
3. **Webhook Ingestion & Production Resilience:**
   - Migrate Telegram bot from long polling to secure HTTPS Webhooks.
   - Health checks, Prometheus metrics, and automated cluster recovery.
4. **Subscription & Multi-Zone Management:**
   - Users can monitor multiple zones (e.g., Home, Work, Vacation home).
   - Zone-specific alerting preferences and notifications.

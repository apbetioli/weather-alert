import type { StormAlert, MatchedUser } from '../engine/types';

/**
 * Escapes reserved characters for Telegram HTML mode:
 * & -> &amp;
 * < -> &lt;
 * > -> &gt;
 * All other punctuation (., -, !, ~, (, ), {, }, etc.) does NOT need escaping in HTML!
 */
export function escapeHtml(text: string | number): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes reserved MarkdownV2 characters in Telegram:
 * \ _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdownV2(text: string | number): string {
  return String(text).replace(/[\\[\]()~>#+=|{}.!_*`\\-]/g, '\\$&');
}

/**
 * Formats a severe hail storm alert into a safe, bulletproof Telegram HTML message.
 * HTML mode completely avoids MarkdownV2 escaping pitfalls with dots, hyphens, and tildes.
 */
export function formatHailAlertHtml(alert: StormAlert, user: MatchedUser, reason?: string): string {
  const now = new Date();
  const etaDate = new Date(now.getTime() + alert.etaMinutes * 60 * 1000);
  const etaClock = etaDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const escapedLocation = escapeHtml(user.locationName);
  const escapedH3 = escapeHtml(user.h3Res7);
  const escapedHailCm = escapeHtml(alert.hailSizeCm);
  const escapedHailDesc = escapeHtml(alert.hailDescription);
  const escapedSpeed = escapeHtml(alert.speedKmh);
  const escapedDirection = escapeHtml(alert.direction);
  const escapedDbz = escapeHtml(alert.maxDbz);
  const escapedInstruction = escapeHtml(alert.instruction);

  const escalationBadge =
    reason === 'ESCALATION'
      ? `🔺 <b>ESCALATION: HAIL SEVERITY INCREASED TO ${escapedHailCm} CM!</b> 🔺\n\n`
      : '';

  return (
    escalationBadge +
    `⚠️ <b>SEVERE WEATHER ALERT: HAIL DETECTED</b>\n\n` +
    `A severe convective storm cell is tracking toward your monitored location (<b>${escapedLocation}</b>).\n\n` +
    `• <b>Est. Arrival Time (ETA):</b> ~${alert.etaMinutes} min (${etaClock})\n` +
    `• <b>Predicted Hail Diameter:</b> ${escapedHailCm} cm (${escapedHailDesc})\n` +
    `• <b>Storm Velocity:</b> ${escapedSpeed} km/h moving ${escapedDirection}\n` +
    `• <b>Radar Core Intensity:</b> ${escapedDbz} dBZ\n` +
    `• <b>Spatial Index (H3 Res 7):</b> <code>${escapedH3}</code>\n\n` +
    `🚗 <b>Recommended Action:</b>\n` +
    `${escapedInstruction}`
  );
}

/**
 * Backward-compatible alias defaulting to bulletproof HTML formatting.
 */
export const formatHailAlert = formatHailAlertHtml;

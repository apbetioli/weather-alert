import {
  type StormAlert,
  type MatchedUser,
  METEOALARM_AWARENESS_LEVELS,
  METEOALARM_HAZARDS,
} from '../engine/types';
import { env } from '../config/env';

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
 * Formats ISO timestamp unambiguously into European DD/MM/YYYY HH:mm format.
 */
export function formatDateTime(iso?: string): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'N/A';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

export function formatDateWindow(onsetIso?: string, expiresIso?: string): string {
  return `${formatDateTime(onsetIso)} → ${formatDateTime(expiresIso)}`;
}

/**
 * Formats a weather alert into a safe, bulletproof Telegram HTML message
 * using the official color code (🟡 Gialla, 🟠 Arancione, 🔴 Rossa) and MeteoAlarm symbols.
 */
export function formatAlertHtml(alert: StormAlert, user: MatchedUser, reason?: string): string {
  const escapedLocation = escapeHtml(user.locationName);
  const escapedH3 = escapeHtml(user.h3Index);
  const escapedInstruction = escapeHtml(alert.instruction);

  // Determine official color badge and name
  const color = alert.color || (alert.severity === 'EMERGENCY' ? 'RED' : alert.severity === 'WARNING' ? 'ORANGE' : 'YELLOW');
  const colorBadge = color === 'RED' ? '🔴' : color === 'ORANGE' ? '🟠' : '🟡';
  const colorName = color === 'RED' ? 'RED ALERT' : color === 'ORANGE' ? 'ORANGE ALERT' : 'YELLOW ALERT';

  const hazardMeta = METEOALARM_HAZARDS[alert.hazardType] || METEOALARM_HAZARDS.OTHER;
  const awareness = METEOALARM_AWARENESS_LEVELS[color];

  const escalationBadge =
    reason === 'ESCALATION'
      ? `🔺 <b>ESCALATION: ALERT SEVERITY INCREASED TO ${colorName}!</b> 🔺\n\n`
      : '';

  const validitySection =
    alert.onset || alert.expires
      ? `• <b>Validity Period:</b> <code>${formatDateWindow(alert.onset, alert.expires)}</code>\n`
      : '';

  const metricsSection =
    `• <b>Hazard:</b> ${hazardMeta.symbol} ${escapeHtml(hazardMeta.nameEn)}\n` +
    (alert.description ? `• <b>Details:</b> <i>${escapeHtml(alert.description.slice(0, 180))}...</i>\n` : '');

  const guidanceSection = awareness
    ? `ℹ️ <b>Official Level:</b> ${escapeHtml(awareness.summary)}\n\n`
    : '\n';

  return (
    escalationBadge +
    `${colorBadge} <b>${colorName}: ${hazardMeta.symbol} ${escapeHtml(alert.event)}</b>\n\n` +
    `📍 <b>Monitored Area:</b> ${escapedLocation}\n\n` +
    validitySection +
    metricsSection +
    `• <b>Spatial Index (H3 Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n\n` +
    guidanceSection +
    `🛡️ <b>Recommended Actions:</b>\n` +
    `${escapedInstruction}`
  );
}


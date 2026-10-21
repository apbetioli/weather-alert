import {
  type StormAlert,
  type MatchedUser,
  METEOALARM_HAZARDS,
} from '../engine/types';
import { env } from '../config/env';
import type { RadarApproachNotice } from '../queue';

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

function escapeHtmlWithinLimit(value: string | number, maxLength: number): string {
  const input = String(value);
  let output = '';
  for (const char of input) {
    const escaped = escapeHtml(char);
    if (output.length + escaped.length > maxLength) break;
    output += escaped;
  }
  if (output.length < escapeHtml(input).length && output.length + 3 <= maxLength) output += '...';
  return output;
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
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')} UTC`;
}

export function formatDateWindow(onsetIso?: string, expiresIso?: string): string {
  if (onsetIso && expiresIso) return `${formatDateTime(onsetIso)} → ${formatDateTime(expiresIso)}`;
  if (onsetIso) return `from ${formatDateTime(onsetIso)}`;
  if (expiresIso) return `until ${formatDateTime(expiresIso)}`;
  return 'N/A';
}

/**
 * Formats a weather alert into a safe, bulletproof Telegram HTML message
 * using the official color code (🟡 Gialla, 🟠 Arancione, 🔴 Rossa) and MeteoAlarm symbols.
 */
export function formatAlertHtml(
  alert: Omit<StormAlert, 'polygonGeoJson'>,
  user: MatchedUser,
  reason?: string
): string {
  const escapedLocation = escapeHtmlWithinLimit(user.locationName, 400);
  const escapedH3 = escapeHtml(user.h3Index);
  const escapedInstruction = escapeHtmlWithinLimit(alert.instruction, 1300);
  const escapedEvent = escapeHtmlWithinLimit(alert.event, 500);

  // Determine official color badge and name
  const color = alert.color || (alert.severity === 'EMERGENCY' ? 'RED' : alert.severity === 'WARNING' ? 'ORANGE' : 'YELLOW');
  const colorBadge = color === 'RED' ? '🔴' : color === 'ORANGE' ? '🟠' : '🟡';
  const colorName = color === 'RED' ? 'RED ALERT' : color === 'ORANGE' ? 'ORANGE ALERT' : 'YELLOW ALERT';

  const hazardMeta = METEOALARM_HAZARDS[alert.hazardType] || METEOALARM_HAZARDS.OTHER;
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
    (alert.description ? `• <b>Details:</b> <i>${escapeHtmlWithinLimit(alert.description, 700)}</i>\n` : '');

  return (
    escalationBadge +
    `${colorBadge} <b>${colorName}: ${hazardMeta.symbol} ${escapedEvent}</b>\n\n` +
    `📍 <b>Monitored Area:</b> ${escapedLocation}\n\n` +
    validitySection +
    metricsSection +
    `• <b>Spatial Index (H3 Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n\n` +
    `🛡️ <b>Recommended Actions:</b>\n` +
    `${escapedInstruction}`
  );
}

export function formatRadarApproachHtml(notice: RadarApproachNotice, user: MatchedUser): string {
  return (
    `📡 <b>Radar echo approaching your monitored location</b>\n\n` +
    `📍 <b>Location:</b> ${escapeHtml(user.locationName)}\n` +
    `⏱️ <b>Estimated closest approach:</b> about ${notice.etaMinutes} minutes\n` +
    `💨 <b>Recent estimated motion:</b> ${notice.speedKmh.toFixed(0)} km/h\n\n` +
    `<i>This estimate is based on movement between radar scans. It is informational, not an official weather warning. For hazard severity and safety advice, follow MeteoAlarm and your national weather service.</i>`
  );
}

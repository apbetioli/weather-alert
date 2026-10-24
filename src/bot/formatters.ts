import tzLookup from 'tz-lookup';
import {
  type StormAlert,
  type MatchedUser,
  METEOALARM_HAZARDS,
} from '../engine/types';
import { env } from '../config/env';
import type { RadarApproachNotice } from '../queue';
import type { ConsolidatedThresholdAlert } from '../engine/threshold-evaluator';

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
  const fullEscaped = escapeHtml(String(value));
  if (fullEscaped.length <= maxLength) return fullEscaped;
  let output = '';
  for (const char of String(value)) {
    const escaped = escapeHtml(char);
    if (output.length + escaped.length > maxLength) {
      if (output.length + 3 <= maxLength) output += '...';
      break;
    }
    output += escaped;
  }
  return output;
}

/**
 * Formats ISO timestamp into unambiguous European DD/MM/YYYY HH:mm format,
 * showing local time with timezone code and UTC time when a local timezone is provided.
 */
function formatDateTime(iso?: string, timeZone?: string): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'N/A';

  const utcParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const uPart = (type: string) => utcParts.find((p) => p.type === type)?.value || '';
  const utcFormatted = `${uPart('day')}/${uPart('month')}/${uPart('year')} ${uPart('hour')}:${uPart('minute')} UTC`;

  if (!timeZone || timeZone.toUpperCase() === 'UTC') {
    return utcFormatted;
  }

  try {
    const localParts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(d);
    const lPart = (type: string) => localParts.find((p) => p.type === type)?.value || '';
    const tzName = localParts.find((p) => p.type === 'timeZoneName')?.value || timeZone;
    const localFormatted = `${lPart('day')}/${lPart('month')}/${lPart('year')} ${lPart('hour')}:${lPart('minute')} ${tzName}`;

    return `${localFormatted} (${uPart('hour')}:${uPart('minute')} UTC)`;
  } catch {
    return utcFormatted;
  }
}

function formatDateWindow(onsetIso?: string, expiresIso?: string, timeZone?: string): string {
  if (onsetIso && expiresIso) return `${formatDateTime(onsetIso, timeZone)} → ${formatDateTime(expiresIso, timeZone)}`;
  if (onsetIso) return `from ${formatDateTime(onsetIso, timeZone)}`;
  if (expiresIso) return `until ${formatDateTime(expiresIso, timeZone)}`;
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
  let tz: string | undefined;
  if (typeof user.lat === 'number' && typeof user.lon === 'number' && !isNaN(user.lat) && !isNaN(user.lon)) {
    try {
      tz = tzLookup(user.lat, user.lon);
    } catch {
      // fallback
    }
  }

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
      ? `• <b>Validity Period:</b> <code>${formatDateWindow(alert.onset, alert.expires, tz)}</code>\n`
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

/**
 * Maps peak radar reflectivity (dBZ) to a human-readable intensity label
 * and brief expectation, following standard meteorological thresholds.
 */
function describeRadarIntensity(maxDbz: number): { label: string; icon: string; expectation: string } {
  if (maxDbz >= 60) {
    return {
      label: 'Extreme',
      icon: '🟣',
      expectation: 'Expect very heavy rain, large hail, and possible severe wind gusts.',
    };
  }
  if (maxDbz >= 50) {
    return {
      label: 'Very heavy',
      icon: '🔴',
      expectation: 'Expect heavy to torrential rain and possible hail.',
    };
  }
  if (maxDbz >= 45) {
    return {
      label: 'Heavy',
      icon: '🟠',
      expectation: 'Expect heavy rain and possible gusty winds.',
    };
  }
  // MIN_TRACK_REFLECTIVITY_DBZ is 40
  return {
    label: 'Moderate-heavy',
    icon: '🟡',
    expectation: 'Expect moderate to heavy rain.',
  };
}

export function formatRadarApproachHtml(notice: RadarApproachNotice, user: MatchedUser): string {
  const intensity = describeRadarIntensity(notice.maxDbz);
  return (
    `📡 <b>Radar echo approaching your monitored location</b>\n\n` +
    `📍 <b>Location:</b> ${escapeHtml(user.locationName)}\n` +
    `⏱️ <b>Estimated closest approach:</b> about ${notice.etaMinutes} minutes\n` +
    `🧭 <b>Storm movement speed:</b> ${notice.speedKmh.toFixed(0)} km/h\n` +
    `${intensity.icon} <b>Echo intensity:</b> ${intensity.label} (${notice.maxDbz} dBZ)\n\n` +
    `⚠️ ${intensity.expectation}\n\n` +
    `<i>The movement speed is how fast the radar echo is travelling across the ground — it is not a wind speed. This estimate is based on movement between radar scans. It is informational, not an official weather warning. For hazard severity and safety advice, follow MeteoAlarm and your national weather service.</i>`
  );
}

/**
 * Formats an ISO timestamp or Open-Meteo UTC time string into a short time string.
 * When a user timeZone is provided (e.g. "Europe/Rome"), formats as:
 * "20:00 CEST (18:00 UTC)"
 * When no timezone or UTC is specified, formats as:
 * "18:00 UTC"
 */
export function formatShortTime(iso?: string, timeZone?: string): string {
  if (!iso) return '';
  const normalized = iso.endsWith('Z') || /[+-]\d{2}(:\d{2})?$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '';

  const utcHours = String(d.getUTCHours()).padStart(2, '0');
  const utcMinutes = String(d.getUTCMinutes()).padStart(2, '0');
  const utcString = `${utcHours}:${utcMinutes} UTC`;

  if (!timeZone || timeZone.toUpperCase() === 'UTC') {
    return utcString;
  }

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(d);

    const hour = parts.find((p) => p.type === 'hour')?.value || utcHours;
    const minute = parts.find((p) => p.type === 'minute')?.value || utcMinutes;
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || timeZone;

    return `${hour}:${minute} ${tzName} (${utcString})`;
  } catch {
    return utcString;
  }
}

/**
 * Formats a consolidated 24-hour threshold breach alert into a rich Telegram HTML message.
 */
export function formatThresholdAlertHtml(alert: ConsolidatedThresholdAlert): string {
  const location = escapeHtml(alert.locationName);
  const breaches = alert.breaches;

  let tz = alert.timezone;
  if (!tz && typeof alert.lat === 'number' && typeof alert.lon === 'number' && !isNaN(alert.lat) && !isNaN(alert.lon)) {
    try {
      tz = tzLookup(alert.lat, alert.lon);
    } catch {
      // fallback
    }
  }

  if (breaches.length === 1) {
    const b = breaches[0]!;
    const timingDetail = b.peakTime ? ` at ~${formatShortTime(b.peakTime, tz)}` : '';
    const startDetail = b.startTime ? `\n• ⏱️ <b>Expected Start:</b> ~${formatShortTime(b.startTime, tz)}` : '';
    const peakDetail = b.peakDetail ? `\n• 📊 <b>Intensity:</b> ${escapeHtml(b.peakDetail)}` : '';

    return (
      `${b.symbol} <b>Weather Threshold Alert: ${location}</b>\n\n` +
      `<b>${location}</b> is forecasted to receive <b>${b.forecastedValue} ${b.unit}</b> of ${escapeHtml(
        b.title.toLowerCase()
      )} within the next 24 hours, exceeding your configured threshold of <b>${b.configuredThreshold} ${b.unit}</b>.\n` +
      startDetail +
      (b.peakTime ? `\n• ⏱️ <b>Peak Expected:</b> ~${formatShortTime(b.peakTime, tz)}` : '') +
      peakDetail +
      `\n\n🛡️ <b>Recommendation:</b>\n` +
      `${escapeHtml(b.recommendation)}\n\n` +
      `<i>Forecast source: High-resolution European numerical prediction (Open-Meteo). Configurable via /thresholds.</i>`
    );
  }

  // Multi-hazard consolidated card
  const breachLines = breaches
    .map((b) => {
      const peak = b.peakTime ? ` (Peak ~${formatShortTime(b.peakTime, tz)})` : '';
      const detail = b.peakDetail ? ` — <i>${escapeHtml(b.peakDetail)}</i>` : '';
      return (
        `• ${b.symbol} <b>${escapeHtml(b.title)}:</b> Forecasted <b>${b.forecastedValue} ${b.unit}</b> ` +
        `(Threshold: ${b.configuredThreshold} ${b.unit})${peak}${detail}`
      );
    })
    .join('\n');

  const recommendations = breaches
    .map((b) => `• ${escapeHtml(b.recommendation)}`)
    .join('\n');

  return (
    `⚠️ <b>Weather Threshold Alert: ${location}</b>\n\n` +
    `<b>${breaches.length} configured thresholds</b> will be exceeded within the next 24 hours:\n\n` +
    `${breachLines}\n\n` +
    `🛡️ <b>Recommendations:</b>\n` +
    `${recommendations}\n\n` +
    `<i>Forecast source: High-resolution European numerical prediction (Open-Meteo). Configurable via /thresholds.</i>`
  );
}


import type { StormAlert, MatchedUser } from '../engine/types';

/**
 * Escapes reserved MarkdownV2 characters in Telegram:
 * _ * [ ] ( ) ~ > # + - = | { } . !
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[\\[\]()~>#+=|{}.!_*-]/g, '\\$&');
}

/**
 * Formats a severe hail storm alert into a structured Telegram MarkdownV2 message.
 */
export function formatHailAlert(alert: StormAlert, user: MatchedUser): string {
  const now = new Date();
  const etaDate = new Date(now.getTime() + alert.etaMinutes * 60 * 1000);
  const etaClock = etaDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const escapedLocation = escapeMarkdownV2(user.locationName);
  const escapedH3 = escapeMarkdownV2(user.h3Res7);
  const escapedEtaMinutes = escapeMarkdownV2(String(alert.etaMinutes));
  const escapedEtaClock = escapeMarkdownV2(etaClock);
  const escapedHailCm = escapeMarkdownV2(String(alert.hailSizeCm));
  const escapedHailDesc = escapeMarkdownV2(alert.hailDescription);
  const escapedSpeed = escapeMarkdownV2(String(alert.speedKmh));
  const escapedDirection = escapeMarkdownV2(alert.direction);
  const escapedDbz = escapeMarkdownV2(String(alert.maxDbz));
  const escapedInstruction = escapeMarkdownV2(alert.instruction);

  return (
    `⚠️ *SEVERE WEATHER ALERT: HAIL DETECTED*\n\n` +
    `A severe convective storm cell is tracking toward your monitored location \\(*${escapedLocation}*\\)\\.\n\n` +
    `• *Est\\. Arrival Time \\(ETA\\):* \\~${escapedEtaMinutes} min \\(${escapedEtaClock}\\)\n` +
    `• *Predicted Hail Diameter:* ${escapedHailCm} cm \\(${escapedHailDesc}\\)\n` +
    `• *Storm Velocity:* ${escapedSpeed} km/h moving ${escapedDirection}\n` +
    `• *Radar Core Intensity:* ${escapedDbz} dBZ\n` +
    `• *Spatial Index \\(H3 Res 7\\):* \`${escapedH3}\`\n\n` +
    `🚗 *Recommended Action:*\n` +
    `${escapedInstruction}`
  );
}

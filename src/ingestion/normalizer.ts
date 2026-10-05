import type { StormAlert, AlertColor, HazardType } from '../engine/types';
import type { RawMeteoAlarmAlert, ParsedAwarenessLevel, ParsedAwarenessType } from './types';

export const AWARENESS_CODE_TO_HAZARD: Record<number, HazardType> = {
  1: 'WIND',
  2: 'SNOW_ICE',
  3: 'THUNDERSTORM',
  4: 'FOG',
  5: 'HIGH_TEMPERATURE',
  6: 'LOW_TEMPERATURE',
  7: 'COASTAL_EVENT',
  8: 'FOREST_FIRE',
  9: 'AVALANCHE',
  10: 'RAIN',
  11: 'FLOOD',
  12: 'RAIN_FLOOD',
  13: 'MARINE_HAZARD',
  14: 'DROUGHT',
};

/**
 * Maps MeteoAlarm CAP severity strings, awareness level, and event text to official color code:
 * Level 2 / Moderate / Yellow -> YELLOW (Allerta Gialla)
 * Level 3 / Severe / Orange   -> ORANGE (Allerta Arancione)
 * Level 4 / Extreme / Red     -> RED (Allerta Rossa)
 */
export function mapAlertColor(
  rawSeverity?: string,
  rawEvent?: string,
  awarenessLevel?: ParsedAwarenessLevel
): {
  color: AlertColor;
  colorName: 'YELLOW' | 'ORANGE' | 'RED';
  severity: 'WATCH' | 'WARNING' | 'EMERGENCY';
} {
  if (awarenessLevel) {
    if (awarenessLevel.numericLevel >= 4 || awarenessLevel.colorName === 'red') {
      return { color: 'RED', colorName: 'RED', severity: 'EMERGENCY' };
    }
    if (awarenessLevel.numericLevel === 3 || awarenessLevel.colorName === 'orange') {
      return { color: 'ORANGE', colorName: 'ORANGE', severity: 'WARNING' };
    }
    return { color: 'YELLOW', colorName: 'YELLOW', severity: 'WATCH' };
  }

  const text = `${rawSeverity || ''} ${rawEvent || ''}`.toLowerCase();

  if (text.includes('extreme') || text.includes('rossa') || text.includes('red')) {
    return { color: 'RED', colorName: 'RED', severity: 'EMERGENCY' };
  }
  if (text.includes('severe') || text.includes('arancione') || text.includes('orange')) {
    return { color: 'ORANGE', colorName: 'ORANGE', severity: 'WARNING' };
  }
  return { color: 'YELLOW', colorName: 'YELLOW', severity: 'WATCH' };
}

/**
 * Detects the specific weather hazard type from the awareness_type parameter
 * or CAP event name and description.
 * Covers all 14 official MeteoAlarm hazard types plus HAIL.
 */
export function detectHazardType(
  event: string,
  headline?: string,
  description?: string,
  awarenessType?: ParsedAwarenessType
): HazardType {
  const combined = `${event} ${headline || ''} ${description || ''}`.toLowerCase();

  // Hail takes precedence for convective precision
  if (combined.includes('hail') || combined.includes('grandine')) return 'HAIL';

  // Use structured MeteoAlarm awareness type if available
  if (awarenessType?.typeCode && AWARENESS_CODE_TO_HAZARD[awarenessType.typeCode]) {
    return AWARENESS_CODE_TO_HAZARD[awarenessType.typeCode]!;
  }

  if (combined.includes('thunderstorm') || combined.includes('temporali') || combined.includes('temporale')) {
    return 'THUNDERSTORM';
  }
  if (combined.includes('flash flood') || combined.includes('rain flood') || combined.includes('nubifragio')) {
    return 'RAIN_FLOOD';
  }
  if (combined.includes('flood') || combined.includes('alluvione') || combined.includes('esondaz')) {
    return 'FLOOD';
  }
  if (combined.includes('rain') || combined.includes('pioggia') || combined.includes('piogge')) {
    return 'RAIN';
  }
  if (combined.includes('wind') || combined.includes('vento') || combined.includes('raffiche') || combined.includes('gust')) {
    return 'WIND';
  }
  if (
    combined.includes('snow') ||
    combined.includes('neve') ||
    combined.includes('ice') ||
    combined.includes('ghiaccio') ||
    combined.includes('gelicidio')
  ) {
    return 'SNOW_ICE';
  }
  if (combined.includes('fog') || combined.includes('nebbia')) {
    return 'FOG';
  }
  if (
    combined.includes('heat') ||
    combined.includes('calore') ||
    combined.includes('caldo') ||
    combined.includes('high temperature')
  ) {
    return 'HIGH_TEMPERATURE';
  }
  if (
    combined.includes('cold') ||
    combined.includes('freddo') ||
    combined.includes('low temperature') ||
    combined.includes('gelo')
  ) {
    return 'LOW_TEMPERATURE';
  }
  if (
    combined.includes('coastal') ||
    combined.includes('costier') ||
    combined.includes('mareggiata') ||
    combined.includes('marea')
  ) {
    return 'COASTAL_EVENT';
  }
  if (combined.includes('fire') || combined.includes('incendi') || combined.includes('wildfire')) {
    return 'FOREST_FIRE';
  }
  if (combined.includes('avalanche') || combined.includes('valangh') || combined.includes('slavina')) {
    return 'AVALANCHE';
  }
  if (
    combined.includes('marine') ||
    combined.includes('marittim') ||
    combined.includes('mare molto mosso') ||
    combined.includes('mare agitato')
  ) {
    return 'MARINE_HAZARD';
  }
  if (combined.includes('drought') || combined.includes('siccit')) {
    return 'DROUGHT';
  }
  return 'OTHER';
}

/**
 * Calculates estimated arrival time (in minutes) based on effective/onset dates.
 * Returns 0 if warning is currently active.
 */
export function calculateEtaMinutes(effectiveIso?: string, onsetIso?: string): number {
  const targetTimeStr = onsetIso || effectiveIso;
  if (!targetTimeStr) return 0;

  const targetTime = new Date(targetTimeStr).getTime();
  const now = Date.now();
  const diffMinutes = Math.round((targetTime - now) / (60 * 1000));

  // If warning is already active or in the past, return 0 (currently active)
  if (diffMinutes <= 0 || isNaN(diffMinutes)) {
    return 0;
  }

  // Cap between 5 and 720 minutes for forward alerts
  return Math.min(Math.max(diffMinutes, 5), 720);
}

/**
 * Formats user safety instructions, incorporating official CAP instructions or sensible defaults
 * based on MeteoAlarm official awareness guidance and hazard characteristics.
 */
export function formatSafetyInstructions(raw: RawMeteoAlarmAlert, hazardType: HazardType, color: AlertColor): string {
  if (raw.instruction && raw.instruction.trim().length > 10) {
    return raw.instruction.trim();
  }

  if (hazardType === 'HAIL') {
    return (
      'Move vehicles to a garage or under a covered roof immediately. ' +
      'Stay away from verandas, windows, and skylights.'
    );
  }

  if (hazardType === 'THUNDERSTORM') {
    return (
      'Possible lightning, violent wind gusts, and local hail. ' +
      'Park vehicles indoors and stay away from isolated trees and outdoor scaffolding.'
    );
  }

  if (hazardType === 'WIND') {
    return (
      'Secure awnings, pots, and outdoor furniture. ' +
      'Pay maximum attention when driving on exposed sections or viaducts.'
    );
  }

  if (hazardType === 'RAIN' || hazardType === 'FLOOD' || hazardType === 'RAIN_FLOOD') {
    return (
      'Avoid underpasses, riverbanks, and areas at risk of flooding. ' +
      'Do not stay in basements or underground levels.'
    );
  }

  if (hazardType === 'SNOW_ICE') {
    return 'Beware of slippery road surfaces. Use winter tires or keep snow chains on board.';
  }

  if (hazardType === 'FOG') {
    return 'Severely reduced visibility. Reduce speed and use fog lights.';
  }

  if (hazardType === 'HIGH_TEMPERATURE') {
    return 'Avoid exposure to the sun during peak hours and hydrate regularly. Pay attention to the elderly or frail.';
  }

  if (hazardType === 'LOW_TEMPERATURE') {
    return 'Protect yourself adequately from the cold and beware of ice formation on roads and sidewalks.';
  }

  if (hazardType === 'FOREST_FIRE') {
    return 'Absolute ban on lighting fires outdoors. Promptly report any starting fires.';
  }

  if (hazardType === 'AVALANCHE') {
    return 'Danger of avalanches. Avoid off-piste activities on risky slopes.';
  }

  if (hazardType === 'COASTAL_EVENT' || hazardType === 'MARINE_HAZARD') {
    return 'Pay attention along coastlines, piers, and cliffs. Avoid swimming and securely moor boats.';
  }

  if (hazardType === 'DROUGHT') {
    return 'Limit the non-essential use of water resources.';
  }

  return 'Stay informed through official Civil Protection bulletins.';
}

/**
 * Normalizes a raw MeteoAlarm CAP alert into a standard StormAlert.
 */
export function normalizeMeteoAlarmAlert(raw: RawMeteoAlarmAlert): StormAlert {
  const { color, colorName, severity } = mapAlertColor(raw.severity, raw.event, raw.awarenessLevel);
  const hazardType = detectHazardType(raw.event, raw.headline, raw.description, raw.awarenessType);
  const severityRank = color === 'RED' ? 3 : color === 'ORANGE' ? 2 : 1;

  const etaMinutes = calculateEtaMinutes(raw.effective, raw.onset);
  const instruction = formatSafetyInstructions(raw, hazardType, color);

  // Sanitize cell identifier for Redis keys and BullMQ job uniqueness
  const safeIdentifier = raw.identifier.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const cellId = `CAP_${safeIdentifier}`;

  const coordinates =
    raw.polygonCoords && (raw.polygonCoords as any[]).length > 0
      ? (raw.polygonCoords as any)
      : [];

  return {
    cellId,
    event: raw.event,
    severity,
    color,
    colorName,
    hazardType,
    severityRank,
    polygonGeoJson: {
      type: raw.polygonType || 'Polygon',
      coordinates,
    },
    instruction,
    headline: raw.headline,
    description: raw.description,
    areaDesc: raw.areaDesc,
    onset: raw.onset || raw.effective,
    expires: raw.expires,
  };
}

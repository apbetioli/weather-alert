import tzLookup from 'tz-lookup';
import type { RollingForecast24h } from '../ingestion/providers/open-meteo';
import type { UserThresholdPreferences } from '../db/schema';

export type ThresholdMetricType = 'RAIN' | 'SNOW' | 'WIND' | 'FROST' | 'HEAT' | 'HAIL';

export interface BreachedThreshold {
  metric: ThresholdMetricType;
  title: string;
  symbol: string;
  forecastedValue: number;
  configuredThreshold: number;
  unit: string;
  startTime?: string;
  peakTime?: string;
  peakDetail?: string;
  recommendation: string;
  severityRank: number; // 1 = moderate, 2 = severe, 3 = extreme
}

export interface ConsolidatedThresholdAlert {
  chatId: number;
  locationName: string;
  lat: number;
  lon: number;
  timezone?: string;
  windowStartTime: string;
  windowEndTime: string;
  breaches: BreachedThreshold[];
}

/**
 * Evaluates a 24-hour numerical forecast against user-defined threshold preferences
 * and returns all active breaches bundled into a consolidated structure.
 */
export function evaluateWeatherThresholds(
  user: { telegramChatId: number; locationName: string; lat: number; lon: number; timezone?: string },
  preferences: UserThresholdPreferences,
  forecast: RollingForecast24h,
  referenceTime: Date | number = Date.now()
): ConsolidatedThresholdAlert | null {
  const steps = forecast.steps;
  if (!steps || steps.length === 0) return null;

  const refTimeMs = typeof referenceTime === 'number' ? referenceTime : referenceTime.getTime();

  // Guard: filter out steps whose hourly window has completely passed relative to referenceTime
  const activeSteps = steps.filter((step) => {
    const stepMs = new Date(step.time).getTime();
    if (isNaN(stepMs)) return false;
    // An hourly step [stepMs, stepMs + 1h) is in the past if stepMs + 1h <= refTimeMs
    return stepMs + 3600 * 1000 > refTimeMs;
  });

  if (activeSteps.length === 0) return null;

  const breaches: BreachedThreshold[] = [];

  // 1. 🌧️ Rainfall Accumulation
  if (preferences.rainEnabled) {
    const thresholdMm = Number(preferences.rainThresholdMm);
    let totalRainMm = 0;
    let maxHourlyRain = 0;
    let peakRainTime = '';
    let firstRainTime = '';

    for (const step of activeSteps) {
      totalRainMm += step.precipitationMm;
      if (step.precipitationMm > 0 && !firstRainTime) {
        firstRainTime = step.time;
      }
      if (step.precipitationMm > maxHourlyRain) {
        maxHourlyRain = step.precipitationMm;
        peakRainTime = step.time;
      }
    }

    if (totalRainMm >= thresholdMm && thresholdMm > 0) {
      breaches.push({
        metric: 'RAIN',
        title: 'Rainfall',
        symbol: '🌧️',
        forecastedValue: Number(totalRainMm.toFixed(2)),
        configuredThreshold: thresholdMm,
        unit: 'mm',
        startTime: firstRainTime,
        peakTime: peakRainTime,
        peakDetail: maxHourlyRain > 0 ? `Peak rate ~${maxHourlyRain.toFixed(1)} mm/h` : undefined,
        recommendation:
          totalRainMm >= 25
            ? 'Heavy rainfall expected. Beware of localized water pooling and slow road traffic.'
            : 'Plan for steady rain today. Carry an umbrella and waterproof clothing.',
        severityRank: totalRainMm >= 30 ? 3 : totalRainMm >= 15 ? 2 : 1,
      });
    }
  }

  // 2. ❄️ Snowfall Accumulation
  if (preferences.snowEnabled) {
    const thresholdCm = Number(preferences.snowThresholdCm);
    let totalSnowCm = 0;
    let peakSnowTime = '';
    let maxHourlySnow = 0;

    for (const step of activeSteps) {
      totalSnowCm += step.snowfallCm;
      if (step.snowfallCm > maxHourlySnow) {
        maxHourlySnow = step.snowfallCm;
        peakSnowTime = step.time;
      }
    }

    if (totalSnowCm >= thresholdCm && thresholdCm > 0) {
      breaches.push({
        metric: 'SNOW',
        title: 'Snowfall',
        symbol: '❄️',
        forecastedValue: Number(totalSnowCm.toFixed(1)),
        configuredThreshold: thresholdCm,
        unit: 'cm',
        peakTime: peakSnowTime,
        recommendation:
          totalSnowCm >= 10
            ? 'Significant snow accumulation expected. Major travel delays likely; use winter tires/chains.'
            : 'Slippery road conditions possible. Allow extra commute time.',
        severityRank: totalSnowCm >= 15 ? 3 : totalSnowCm >= 5 ? 2 : 1,
      });
    }
  }

  // 3. 💨 Peak Wind Gusts
  if (preferences.windEnabled) {
    const thresholdKmh = Number(preferences.windThresholdKmh);
    let maxGustKmh = 0;
    let peakGustTime = '';

    for (const step of activeSteps) {
      if (step.windGustKmh > maxGustKmh) {
        maxGustKmh = step.windGustKmh;
        peakGustTime = step.time;
      }
    }

    if (maxGustKmh >= thresholdKmh && thresholdKmh > 0) {
      breaches.push({
        metric: 'WIND',
        title: 'Wind Gusts',
        symbol: '💨',
        forecastedValue: Math.round(maxGustKmh),
        configuredThreshold: thresholdKmh,
        unit: 'km/h',
        peakTime: peakGustTime,
        recommendation:
          maxGustKmh >= 90
            ? 'Damaging gale-force winds expected! Secure all outdoor furniture and watch for falling branches.'
            : 'Gusty conditions expected. Secure lightweight objects outdoors.',
        severityRank: maxGustKmh >= 90 ? 3 : maxGustKmh >= 70 ? 2 : 1,
      });
    }
  }

  // 4. 🥶 Frost / Sub-Zero Temperatures
  if (preferences.frostEnabled) {
    const thresholdC = Number(preferences.frostThresholdC);
    let minTempC = 999;
    let lowestTempTime = '';

    for (const step of activeSteps) {
      if (step.temperatureC < minTempC) {
        minTempC = step.temperatureC;
        lowestTempTime = step.time;
      }
    }

    if (minTempC <= thresholdC) {
      breaches.push({
        metric: 'FROST',
        title: 'Frost & Freeze',
        symbol: '🥶',
        forecastedValue: Number(minTempC.toFixed(1)),
        configuredThreshold: thresholdC,
        unit: '°C',
        peakTime: lowestTempTime,
        recommendation:
          minTempC <= -5
            ? 'Severe freeze expected. Protect vulnerable exposed pipes and bring sensitive plants indoors.'
            : 'Frosty sub-zero temperatures expected. Watch for black ice on roads and windshield frost.',
        severityRank: minTempC <= -5 ? 3 : minTempC <= -2 ? 2 : 1,
      });
    }
  }

  // 5. 🌡️ Extreme Heat
  if (preferences.heatEnabled) {
    const thresholdC = Number(preferences.heatThresholdC);
    let maxTempC = -999;
    let peakHeatTime = '';

    for (const step of activeSteps) {
      if (step.temperatureC > maxTempC) {
        maxTempC = step.temperatureC;
        peakHeatTime = step.time;
      }
    }

    if (maxTempC >= thresholdC && thresholdC > 0) {
      breaches.push({
        metric: 'HEAT',
        title: 'Extreme Heat',
        symbol: '🌡️',
        forecastedValue: Number(maxTempC.toFixed(1)),
        configuredThreshold: thresholdC,
        unit: '°C',
        peakTime: peakHeatTime,
        recommendation:
          maxTempC >= 38
            ? 'Dangerous heat wave conditions. Stay hydrated, avoid midday sun, and check on elderly relatives.'
            : 'High temperature alert. Keep hydrated and limit strenuous outdoor exercise during peak afternoon hours.',
        severityRank: maxTempC >= 38 ? 3 : maxTempC >= 35 ? 2 : 1,
      });
    }
  }

  // 6. 🧊 Convective Hail Risk
  if (preferences.hailMode > 0) {
    const severeHailCodes = [90, 99];
    const anyHailCodes = [89, 90, 96, 99];
    let detectedHailStep: (typeof activeSteps)[0] | undefined;
    let isSevere = false;

    for (const step of activeSteps) {
      if (severeHailCodes.includes(step.weatherCode) || (step.capeJkg >= 1500 && [95, 96, 99].includes(step.weatherCode))) {
        detectedHailStep = step;
        isSevere = true;
        break;
      } else if (
        preferences.hailMode === 1 &&
        (anyHailCodes.includes(step.weatherCode) || (step.capeJkg >= 1000 && [95, 96, 99].includes(step.weatherCode)))
      ) {
        detectedHailStep = step;
      }
    }

    if (detectedHailStep && (preferences.hailMode === 1 || isSevere)) {
      breaches.push({
        metric: 'HAIL',
        title: 'Hail Risk',
        symbol: '🧊',
        forecastedValue: isSevere ? 2 : 1,
        configuredThreshold: preferences.hailMode,
        unit: isSevere ? 'Severe Risk' : 'Moderate Risk',
        peakTime: detectedHailStep.time,
        peakDetail: `CAPE ~${detectedHailStep.capeJkg} J/kg, WMO Code ${detectedHailStep.weatherCode}`,
        recommendation:
          'Severe convective storm conditions favorable for hail. Consider parking vehicles under cover or in a garage.',
        severityRank: isSevere ? 3 : 2,
      });
    }
  }

  // Double-check: ensure every breach has a peak time that hasn't completely elapsed
  const futureBreaches = breaches.filter((b) => {
    if (!b.peakTime) return true;
    const peakMs = new Date(b.peakTime).getTime();
    return isNaN(peakMs) || peakMs + 3600 * 1000 > refTimeMs;
  });

  if (futureBreaches.length === 0) return null;

  let resolvedTz = user.timezone;
  if (!resolvedTz && typeof user.lat === 'number' && typeof user.lon === 'number' && !isNaN(user.lat) && !isNaN(user.lon)) {
    try {
      resolvedTz = tzLookup(user.lat, user.lon);
    } catch {
      // fallback
    }
  }

  return {
    chatId: user.telegramChatId,
    locationName: user.locationName,
    lat: user.lat,
    lon: user.lon,
    timezone: resolvedTz,
    windowStartTime: activeSteps[0]?.time || forecast.startTime,
    windowEndTime: activeSteps[activeSteps.length - 1]?.time || forecast.endTime,
    breaches: futureBreaches,
  };
}

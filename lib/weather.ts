/**
 * Adapted from an existing `getLocalWeather` tool: NOAA National Weather
 * Service forecast + active alerts. The tool definition (description and
 * schema) lives in `tools/index.ts`.
 *
 * A plain function with no retry logic of its own. It separates two kinds of
 * failure so its caller can treat them differently:
 * - a location NWS cannot serve is an answer, returned as `{ error }` for the
 *   model to relay; asking again will not change it.
 * - anything else (network errors, the 5xx responses NWS is known for) is
 *   thrown, so the durable wrapper in `tools/durable.ts` retries it.
 */

const NWS_API_BASE_URL =
  process.env.NWS_API_BASE_URL ?? 'https://api.weather.gov';

// NWS asks for a descriptive User-Agent identifying the app and a contact so
// they can reach out about problematic traffic. Requests without one are
// rejected.
const NWS_USER_AGENT = process.env.NWS_USER_AGENT ?? 'durable-ai-sdk-demo';

interface NwsForecastPeriod {
  name?: string;
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: { value: number | null };
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  detailedForecast?: string;
}

interface NwsAlertFeature {
  properties?: {
    event?: string;
    severity?: string;
    headline?: string;
    onset?: string;
    ends?: string;
    description?: string;
  };
}

async function fetchNwsJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': NWS_USER_AGENT,
      Accept: 'application/geo+json',
    },
  });
  if (response.status === 404) throw new NwsNotFoundError(url);
  if (!response.ok) {
    throw new Error(`NWS request failed with status ${response.status}`);
  }
  return await response.json();
}

/** NWS has no forecast for this location; retrying cannot help. */
class LocationNotCoveredError extends Error {}

class NwsNotFoundError extends Error {
  constructor(url: string) {
    super(`NWS returned 404 for ${url}`);
    this.name = 'NwsNotFoundError';
  }
}

// The points endpoint rejects coordinates with more than 4 decimal places
// (it responds with a 301 redirect instead of data), so always round.
function roundCoordinate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function condensePeriod(period: NwsForecastPeriod) {
  return {
    name: period.name || null,
    startTime: period.startTime || null,
    endTime: period.endTime || null,
    isDaytime: period.isDaytime ?? null,
    temperature: period.temperature ?? null,
    temperatureUnit: period.temperatureUnit || null,
    precipitationChancePercent:
      period.probabilityOfPrecipitation?.value ?? null,
    windSpeed: period.windSpeed || null,
    windDirection: period.windDirection || null,
    shortForecast: period.shortForecast || null,
    detailedForecast: period.detailedForecast || null,
  };
}

function condenseAlert(feature: NwsAlertFeature) {
  const properties = feature.properties ?? {};
  return {
    event: properties.event || null,
    severity: properties.severity || null,
    headline: properties.headline || null,
    onset: properties.onset || null,
    ends: properties.ends || null,
  };
}

const HOURLY_PERIOD_LIMIT = 48;

export interface LocalWeatherInput {
  latitude: number;
  longitude: number;
  forecastType?: 'daily' | 'hourly';
}

export async function getLocalWeather({
  latitude,
  longitude,
  forecastType = 'daily',
}: LocalWeatherInput) {
  const lat = roundCoordinate(latitude);
  const lon = roundCoordinate(longitude);

  try {
    const points = await fetchNwsJson(
      `${NWS_API_BASE_URL}/points/${lat},${lon}`,
    ).catch((error) => {
      if (error instanceof NwsNotFoundError) {
        throw new LocationNotCoveredError(
          'Location is outside National Weather Service coverage. NOAA forecasts are only available for United States territory.',
        );
      }
      throw error;
    });

    const forecastUrl =
      forecastType === 'hourly'
        ? points?.properties?.forecastHourly
        : points?.properties?.forecast;
    if (!forecastUrl) {
      throw new LocationNotCoveredError(
        'NWS did not return a forecast URL for this location. The location may be outside forecast coverage.',
      );
    }

    const relativeLocation = points?.properties?.relativeLocation?.properties;
    const location = {
      latitude: lat,
      longitude: lon,
      city: relativeLocation?.city ?? null,
      state: relativeLocation?.state ?? null,
      timezone: points?.properties?.timeZone ?? null,
    };

    const [forecast, alertsResponse] = await Promise.all([
      fetchNwsJson(forecastUrl),
      fetchNwsJson(
        `${NWS_API_BASE_URL}/alerts/active?point=${lat},${lon}`,
      ).catch((error) => {
        // Alerts are supplementary; do not fail the whole forecast if the
        // alerts endpoint is unavailable.
        return null;
      }),
    ]);

    const rawPeriods: NwsForecastPeriod[] = Array.isArray(
      forecast?.properties?.periods,
    )
      ? forecast.properties.periods
      : [];
    const periods = (
      forecastType === 'hourly'
        ? rawPeriods.slice(0, HOURLY_PERIOD_LIMIT)
        : rawPeriods
    ).map(condensePeriod);

    const alertFeatures: NwsAlertFeature[] = Array.isArray(
      alertsResponse?.features,
    )
      ? alertsResponse.features
      : [];
    const alerts = alertFeatures.map(condenseAlert);

    const result = {
      location,
      forecastType,
      generatedAt: forecast?.properties?.generatedAt ?? null,
      periods,
      alerts,
      alertsUnavailable: alertsResponse === null,
      provenance: {
        source: 'noaa_national_weather_service',
      },
    };

    return result;
  } catch (error) {
    if (!(error instanceof LocationNotCoveredError)) throw error;
    return {
      error: error.message,
      location: { latitude: lat, longitude: lon },
      forecastType,
      periods: [],
      alerts: [],
      provenance: {
        source: 'noaa_national_weather_service',
      },
    };
  }
}

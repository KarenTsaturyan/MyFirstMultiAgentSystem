import { z } from "zod";

const geocodingSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

const forecastSchema = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    apparent_temperature: z.number(),
    precipitation: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()).optional(),
  }),
});

const weatherCodeDescriptions: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(
      `Open-Meteo request failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

export async function getWeatherForecast(
  location: string,
  forecastDays: number,
): Promise<string> {
  const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodingUrl.search = new URLSearchParams({
    name: location,
    count: "1",
    language: "en",
    format: "json",
  }).toString();

  const geocoding = geocodingSchema.parse(await fetchJson(geocodingUrl));
  const place = geocoding.results[0];
  if (!place) {
    throw new Error(`Open-Meteo could not find a location named "${location}".`);
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: String(forecastDays),
    timezone: "auto",
  }).toString();

  const forecast = forecastSchema.parse(await fetchJson(forecastUrl));
  const dailyForecast = forecast.daily.time.map((date, index) => ({
    date,
    conditions:
      weatherCodeDescriptions[forecast.daily.weather_code[index] ?? -1] ??
      "unknown conditions",
    high_celsius: forecast.daily.temperature_2m_max[index],
    low_celsius: forecast.daily.temperature_2m_min[index],
    precipitation_probability_percent:
      forecast.daily.precipitation_probability_max?.[index] ?? null,
  }));

  return JSON.stringify(
    {
      source: "Open-Meteo",
      location: {
        name: place.name,
        region: place.admin1,
        country: place.country,
        timezone: forecast.timezone,
      },
      current: {
        observed_at: forecast.current.time,
        conditions:
          weatherCodeDescriptions[forecast.current.weather_code] ??
          "unknown conditions",
        temperature_celsius: forecast.current.temperature_2m,
        feels_like_celsius: forecast.current.apparent_temperature,
        relative_humidity_percent: forecast.current.relative_humidity_2m,
        precipitation_mm: forecast.current.precipitation,
        wind_speed_kmh: forecast.current.wind_speed_10m,
      },
      daily_forecast: dailyForecast,
      attribution:
        "Weather data from Open-Meteo; attribution is required under CC BY 4.0.",
    },
    null,
    2,
  );
}

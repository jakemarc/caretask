// Dashboard clock card helpers (2026-11-02) — the card's
// background follows the season (from the date) and the time of
// day (from the clock), and its icon follows the actual weather.
// The background is pure local computation — no network. Weather
// comes from Open-Meteo (free, no account or key) for the
// practice area (Hickory Hills, IL); any failure just leaves the
// card without a condition line.

export type Season = "spring" | "summer" | "fall" | "winter";
export type Daypart =
  | "dawn"
  | "morning"
  | "midday"
  | "afternoon"
  | "golden"
  | "dusk"
  | "night";

export function seasonOf(d: Date): Season {
  const m = d.getMonth();
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  if (m >= 8 && m <= 10) return "fall";
  return "winter";
}

export function daypartOf(d: Date): Daypart {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 5 || h >= 20.5) return "night";
  if (h < 7) return "dawn";
  if (h < 11) return "morning";
  if (h < 15) return "midday";
  if (h < 17.5) return "afternoon";
  if (h < 19.5) return "golden";
  return "dusk";
}

export type WeatherGroup =
  | "clear"
  | "partly"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

export interface WeatherNow {
  group: WeatherGroup;
  label: string;
  isDay: boolean;
}

const WMO: Record<number, { group: WeatherGroup; label: string }> = {
  0: { group: "clear", label: "Clear" },
  1: { group: "partly", label: "Mostly clear" },
  2: { group: "partly", label: "Partly cloudy" },
  3: { group: "cloudy", label: "Overcast" },
  45: { group: "fog", label: "Fog" },
  48: { group: "fog", label: "Fog" },
  51: { group: "drizzle", label: "Light drizzle" },
  53: { group: "drizzle", label: "Drizzle" },
  55: { group: "drizzle", label: "Drizzle" },
  56: { group: "drizzle", label: "Freezing drizzle" },
  57: { group: "drizzle", label: "Freezing drizzle" },
  61: { group: "rain", label: "Light rain" },
  63: { group: "rain", label: "Rain" },
  65: { group: "rain", label: "Heavy rain" },
  66: { group: "rain", label: "Freezing rain" },
  67: { group: "rain", label: "Freezing rain" },
  71: { group: "snow", label: "Light snow" },
  73: { group: "snow", label: "Snow" },
  75: { group: "snow", label: "Heavy snow" },
  77: { group: "snow", label: "Snow" },
  80: { group: "rain", label: "Light showers" },
  81: { group: "rain", label: "Showers" },
  82: { group: "rain", label: "Heavy showers" },
  85: { group: "snow", label: "Snow showers" },
  86: { group: "snow", label: "Snow showers" },
  95: { group: "thunder", label: "Thunderstorm" },
  96: { group: "thunder", label: "Thunderstorm with hail" },
  99: { group: "thunder", label: "Thunderstorm with hail" },
};

const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=41.7216&longitude=-87.8484" +
  "&current=weather_code,is_day&timezone=America%2FChicago";

export async function fetchWeather(): Promise<WeatherNow | null> {
  try {
    const res = await fetch(WEATHER_URL, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      current?: { weather_code?: number; is_day?: number };
    };
    const code = data.current?.weather_code;
    if (typeof code !== "number") return null;
    const mapped = WMO[code] ?? { group: "cloudy" as WeatherGroup, label: "Cloudy" };
    return { ...mapped, isDay: data.current?.is_day !== 0 };
  } catch {
    return null;
  }
}

// Theme preferences for the clinician dashboard.
//
// Two independent axes, both persisted in localStorage and both
// applied as attributes on <html> (see App.tsx):
//
// - Mode: light/dark, key `marcinnotech-theme`, attribute
//   `data-theme`. Light is the default to match the modern
//   reference designs.
// - Color theme: the accent palette, key
//   `marcinnotech-color-theme`, attribute `data-color-theme`.
//   "teal" is the original look and the default. Each color theme
//   has BOTH a light and a dark variant in styles.css — the mode
//   axis picks which variant applies.
//
// HARD RULE: the clinical colors are NOT part of the color
// themes. Zone colors and the patient status colors
// (--green / --amber / --red in styles.css) are defined once, in
// the mode blocks only, and stay identical in every color theme —
// green/yellow/red keep their clinical meaning everywhere.
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "marcinnotech-theme";

export function initialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export type ColorTheme = "teal" | "ocean" | "forest" | "sunset" | "plum";

export const COLOR_THEME_STORAGE_KEY = "marcinnotech-color-theme";

export const DEFAULT_COLOR_THEME: ColorTheme = "teal";

// Picker metadata for Settings → Theme. The swatch hexes mirror
// the --teal (accent) and --orange (secondary accent) values in
// styles.css for each theme × mode — if a palette changes in the
// CSS, update the matching entry here so the swatches stay true.
export interface ColorThemeMeta {
  id: ColorTheme;
  name: string;
  blurb: string;
  light: { accent: string; secondary: string };
  dark: { accent: string; secondary: string };
}

export const COLOR_THEMES: ColorThemeMeta[] = [
  {
    id: "teal",
    name: "Teal",
    blurb: "The original CareTask look.",
    light: { accent: "#0d9488", secondary: "#ea580c" },
    dark: { accent: "#14b8a6", secondary: "#fd6828" },
  },
  {
    id: "ocean",
    name: "Ocean",
    blurb: "Calm blues with a cyan secondary.",
    light: { accent: "#2563eb", secondary: "#0891b2" },
    dark: { accent: "#60a5fa", secondary: "#0891b2" },
  },
  {
    id: "forest",
    name: "Forest",
    blurb: "Deep greens with a lime secondary.",
    light: { accent: "#15803d", secondary: "#65a30d" },
    dark: { accent: "#4ade80", secondary: "#65a30d" },
  },
  {
    id: "sunset",
    name: "Sunset",
    blurb: "Warm terracotta with a dusk-pink secondary.",
    light: { accent: "#c2410c", secondary: "#be185d" },
    dark: { accent: "#fb923c", secondary: "#ec4899" },
  },
  {
    id: "plum",
    name: "Plum",
    blurb: "Violet with a fuchsia secondary.",
    light: { accent: "#7c3aed", secondary: "#a21caf" },
    dark: { accent: "#a78bfa", secondary: "#d946ef" },
  },
];

export function isColorTheme(value: string | null): value is ColorTheme {
  return COLOR_THEMES.some((t) => t.id === value);
}

export function initialColorTheme(): ColorTheme {
  try {
    const stored = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
    return isColorTheme(stored) ? stored : DEFAULT_COLOR_THEME;
  } catch {
    return DEFAULT_COLOR_THEME;
  }
}

import { useEffect, useState } from "react";

// Tiny matchMedia hook (2026-11-06): subscribes to a media
// query and re-renders on changes. Used by the Mileage chain
// to switch between its list rendering and the desktop table
// at the stylesheet's wide breakpoint (min-width: 1001px).
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

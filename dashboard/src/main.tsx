import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

// Stale-build self-heal (deploy-35): mobile browsers were serving
// Jake a cached copy of the app after deploys — old code, API
// showing disconnected, incognito worked. An app cannot wipe the
// browser's cache, so instead the app detects staleness: ask the
// server (bypassing every cache) which build is current; if it
// isn't this one, reload once to pick up the fresh shell. The
// sessionStorage flag makes "once" literal — a build that still
// mismatches after the reload (e.g. a CDN edge mid-propagation)
// renders as-is rather than looping.
async function healStaleBuild(): Promise<void> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return;
    const served = (await res.json()) as { build?: string };
    if (!served.build || served.build === __APP_BUILD__) {
      sessionStorage.removeItem("caretask-build-reload");
      return;
    }
    if (sessionStorage.getItem("caretask-build-reload") === served.build) {
      return;
    }
    sessionStorage.setItem("caretask-build-reload", served.build);
    window.location.reload();
  } catch {
    // Offline or blocked — never let the freshness check stop the app.
  }
}
void healStaleBuild();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

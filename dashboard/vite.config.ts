import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// One build stamp per build, shared by the bundle (via define)
// and dist/version.json (emitted below). src/main.tsx compares
// the two on load: if the served version.json names a different
// build than the one running, this tab is holding a stale cached
// bundle (the mobile-browser trap Jake hit repeatedly) and it
// reloads itself once to pick up the current one.
const buildId = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

function versionJson(): Plugin {
  return {
    name: "caretask-version-json",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: buildId }),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionJson()],
  define: {
    __APP_BUILD__: JSON.stringify(buildId),
  },
});

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { HOST } from "./holochain/host";
import { loadLocale } from "./i18n";

// The person's language first, so the first screen is already in it.
await loadLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);

// Only for a production build served to a browser against the dev host
// (see holochain/host.ts) -- a runtime serves the UI from the device, and
// under `vite dev` it would stale-cache the dev server's own module graph.
// See sw.ts for what it caches (the static app shell only).
if (import.meta.env.PROD && HOST === "dev" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

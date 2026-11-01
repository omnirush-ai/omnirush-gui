/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { initializeDenBootstrapConfig } from "./app/lib/den";
import { startWebErrorMonitoring } from "./app/lib/error-monitoring";
import { getOmniRushDeployment } from "./app/lib/omnirush-deployment";
import { bootstrapTheme } from "./app/theme";
import { restoreWallpaper } from "./app/wallpaper";
import { isDesktopRuntime } from "./app/utils";
import { initLocale } from "./i18n";
import { getReactQueryClient } from "./react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { AppProviders } from "./react-app/shell/providers";
import { AppRoot } from "./react-app/shell/app-root";
import { setWebNotificationHandler } from "./react-app/shell/desktop-notifications";
import { startDeepLinkBridge } from "./react-app/shell/startup-deep-links";
import "./app/index.css";

startWebErrorMonitoring();
bootstrapTheme();
void restoreWallpaper();
initLocale();
startDeepLinkBridge();
await initializeDenBootstrapConfig();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.omnirushDeployment = getOmniRushDeployment();

const platform = createDefaultPlatform();
setWebNotificationHandler(platform.notify);
const queryClient = getReactQueryClient();
const Router = isDesktopRuntime() ? HashRouter : BrowserRouter;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlatformProvider value={platform}>
          <AppProviders>
            <Router>
              <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
                <DesktopTitlebar />
                <div className="flex-1 min-h-0 w-full overflow-hidden">
                  <AppRoot />
                </div>
              </div>
            </Router>
          </AppProviders>
        </PlatformProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

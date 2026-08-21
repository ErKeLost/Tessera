import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "@data-elements/react/styles.css";
import "goey-toast/styles.css";
import "./styles.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { StudioApp } from "./studio-app";
import { StudioThemeProvider } from "./studio-theme";

console.info(`[Tessera Studio] v${__TESSERA_STUDIO_VERSION__}`);

const root = document.getElementById("root");
if (!root) throw new Error("Tessera Studio root element is missing.");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <StudioThemeProvider>
          <TooltipProvider>
            <StudioApp />
          </TooltipProvider>
        </StudioThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

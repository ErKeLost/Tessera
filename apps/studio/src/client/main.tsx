import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "@data-elements/react/styles.css";
import "./styles.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { StudioApp } from "./studio-app";
import { StudioThemeProvider } from "./studio-theme";

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

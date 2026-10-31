import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "goey-toast/styles.css";
import "./gooey-toast-theme.css";
import "./styles.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { StudioApp } from "./studio-app";
import { StudioThemeProvider } from "./studio-theme";
import { HeroToastHost } from "./components/generative/heroui-genui/native-catalog";

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
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <StudioThemeProvider>
        <TooltipProvider>
          <StudioApp />
          {/* Sonner needs the theme provider above it and one mount for the whole app. */}
          <Toaster />
          <HeroToastHost />
        </TooltipProvider>
      </StudioThemeProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);

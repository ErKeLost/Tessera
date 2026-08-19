import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router";
import { StudioRouteShell } from "./layout/studio-route-shell";
import { StudioChatRoute } from "./routes/studio-chat-route";
import { StudioDataRoute } from "./routes/studio-data-route";
import { StudioHomeRoute } from "./routes/studio-home-route";
import { StudioNotFoundRoute } from "./routes/studio-not-found-route";
import { useStudioUiStore } from "./store/studio-ui-store";

export function StudioApp() {
  const glass = useStudioUiStore((state) => state.glass);

  useEffect(() => {
    document.documentElement.dataset.glass = glass ? "on" : "off";
  }, [glass]);

  return (
    <main className="studio-shell" data-glass={glass ? "on" : "off"}>
      <Routes>
        <Route element={<StudioRouteShell />}>
          <Route index element={<StudioHomeRoute />} />
          <Route path="chat">
            <Route index element={<Navigate replace to="/" />} />
            <Route path=":threadId" element={<StudioChatRoute />} />
          </Route>
          <Route path="data" element={<StudioDataRoute />} />
          <Route path="settings/*" element={<Navigate replace to="/" />} />
          <Route path="*" element={<StudioNotFoundRoute />} />
        </Route>
      </Routes>
    </main>
  );
}

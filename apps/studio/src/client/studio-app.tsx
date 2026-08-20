import { Route, Routes } from "react-router";
import { StudioRouteShell } from "./layout/studio-route-shell";
import { StudioChatEntryRoute, StudioChatRoute } from "./routes/studio-chat-route";
import { StudioNotFoundRoute } from "./routes/studio-not-found-route";

export function StudioApp() {
  return (
    <main className="studio-shell">
      <Routes>
        <Route element={<StudioRouteShell />}>
          <Route index element={<StudioChatEntryRoute />} />
          <Route path="chat" element={<StudioChatEntryRoute />} />
          <Route path="chat/:threadId" element={<StudioChatRoute />} />
        </Route>
        <Route path="*" element={<StudioNotFoundRoute />} />
      </Routes>
    </main>
  );
}

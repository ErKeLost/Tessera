import { Route, Routes } from "react-router";
import { useEffect, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import { StudioRouteShell } from "./layout/studio-route-shell";
import { StudioChatEntryRoute, StudioChatRoute } from "./routes/studio-chat-route";
import { StudioNotFoundRoute } from "./routes/studio-not-found-route";
import { heroChatLibrary } from "./components/generative/heroui-genui";

const evilChartsPreview = `root = Card([header, bar, line, area, composed, pie, radar, radial, sankey, detailsTitle, details])
header = CardHeader("EvilCharts integration", "Recharts 3.10.1 · installed from the EvilCharts registry")
bar = BarChart(["Sep", "Oct", "Nov", "Dec"], [Series("Registrations", [148, 43, 96, 132]), Series("Projects", [216, 99, 108, 141])])
line = LineChart(["Sep", "Oct", "Nov", "Dec"], [Series("Weekly active", [240, 310, 285, 390])])
area = AreaChart(["Sep", "Oct", "Nov", "Dec"], [Series("Usage", [120, 190, 175, 260])])
composed = ComposedChart(["Sep", "Oct", "Nov", "Dec"], [Series("Revenue", [42, 38, 51, 58]), Series("Orders", [32, 27, 40, 43])])
pie = PieChart([Slice("Phone", 103), Slice("WeChat", 55), Slice("Email", 33)], true)
radar = RadarChart(["Growth", "Retention", "Revenue", "Activation"], [Series("Current", [80, 68, 74, 83])])
radial = RadialChart([Slice("Phone", 103), Slice("WeChat", 55), Slice("Email", 33)])
sankey = SankeyChart([FlowNode("Impressions"), FlowNode("Clicks"), FlowNode("Orders")], [FlowLink("Impressions", "Clicks", 420), FlowLink("Clicks", "Orders", 86)])
detailsTitle = TextContent("TOP10 details", "large-heavy")
details = Table([Col("Note", "string"), Col("Creator", "string"), Col("Spend", "number"), Col("Impressions", "number"), Col("Clicks", "number"), Col("CTR", "string"), Col("GMV", "number"), Col("ROI", "number")], [["Note 01", "Creator A", 2762.87, 32014, 3806, "11.89%", 7180.38, 2.6], ["Note 02", "Creator B", 1508.19, 14390, 2358, "16.39%", 3603.56, 2.39], ["Note 03", "Creator C", 1147.54, 15505, 1834, "11.83%", 3388.31, 2.95], ["Note 04", "Creator D", 1027.08, 8870, 519, "5.85%", 2756.91, 2.68], ["Note 05", "Creator E", 871.41, 9635, 2237, "23.22%", 1949.67, 2.24], ["Note 06", "Creator F", 868.95, 13262, 1577, "11.89%", 1455.67, 1.68], ["Note 07", "Creator G", 740.61, 6443, 1191, "18.49%", 2561.85, 3.46], ["Note 08", "Creator H", 723.56, 5127, 869, "16.95%", 2348.78, 3.25], ["Note 09", "Creator I", 624.1, 4709, 651, "13.82%", 1277.17, 2.05], ["Note 10", "Creator J", 565.71, 9423, 944, "10.02%", 1530.13, 2.7]])`;

function EvilChartsPreview() {
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => setComplete(true), 50);
    return () => window.clearTimeout(timeout);
  }, []);
  return <div style={{ height: "100vh", overflow: "auto", padding: 24 }}><Renderer.Root isStreaming={!complete} library={heroChatLibrary} response={evilChartsPreview}><Renderer.Content /></Renderer.Root></div>;
}

export function StudioApp() {
  return (
    <main className="studio-shell">
      <Routes>
        <Route path="__evilcharts_preview" element={<EvilChartsPreview />} />
        <Route element={<StudioRouteShell />}>
          <Route index element={<StudioChatEntryRoute />} />
          <Route path="chat" element={<StudioChatEntryRoute />} />
          <Route path="chat/:threadId" element={<StudioChatRoute />} />
          <Route path="feishu" element={<StudioChatEntryRoute />} />
          <Route path="feishu/chat/:threadId" element={<StudioChatRoute />} />
        </Route>
        <Route path="*" element={<StudioNotFoundRoute />} />
      </Routes>
    </main>
  );
}

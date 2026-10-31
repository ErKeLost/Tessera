import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

// Run in a separate process from the SSR tests: React Aria checks for DOM at
// module load. Server rendering cannot exercise its tab focus effects.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "SVGElement", "MutationObserver", "NodeFilter"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(dom.window.HTMLElement.prototype, "getAnimations", { value: () => [] });
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 224, width: 640, height: 224, toJSON() {} }) });

const { createRoot } = await import("react-dom/client");
const { useEffect, useRef } = await import("react");
const { useChat } = await import("@ai-sdk/react");
const { DefaultChatTransport } = await import("ai");
const { AnalysisView } = await import("../src/client/components/generative/analysis-view");

const program = [
  "root = Card([header, total, tabs, next])",
  'header = CardHeader("Registration distribution")',
  'data = Query("relation_metrics", {schema: "public", table: "registrations", groupBy: ["provider"], metrics: [{fn: "count", alias: "count"}]}, {columns: [], rows: []})',
  'total = TextContent("Registration distribution")',
  '$tab = "month"',
  'tabs = Tabs([month, provider], "month", $tab)',
  'month = TabItem("month", "Monthly", [chart, table])',
  'chart = BarChart(["Sep", "Oct"], [Series("Users", [148, 44])])',
  'table = Table([Col("Month"), Col("Users", "number")], [["Sep", 148], ["Oct", 44]])',
  'provider = TabItem("provider", "Provider", [pie, counts])',
  'pie = PieChart(@Each(data.rows, "r", Slice(r.provider, r.count)), true)',
  'counts = Table([Col("Provider"), Col("Count", "number")], @Each(data.rows, "r", [r.provider, r.count]))',
  'next = FollowUpBlock([FollowUpItem("Completed stream")])',
].join("\n");

afterAll(() => dom.window.close());

test.each(["compact", "native"])("burst SSE completes and bound %s Tabs remain interactive without a React update loop", async (variant) => {
  const replayProgram = variant === "compact" ? program : program.replace(
    'tabs = Tabs([month, provider], "month", $tab)',
    [
      'tabs = HeroUI("Tabs", [list, monthPanel, providerPanel], {}, "view", $tab)',
      'list = HeroUI("Tabs.ListContainer", [tabList])',
      'tabList = HeroUI("Tabs.List", [monthTrigger, providerTrigger], {"aria-label": "Views"})',
      'monthTrigger = HeroUI("Tabs.Tab", ["Monthly"], {id: "month"})',
      'providerTrigger = HeroUI("Tabs.Tab", ["Provider"], {id: "provider"})',
      'monthPanel = HeroUI("Tabs.Panel", [chart, table], {id: "month"})',
      'providerPanel = HeroUI("Tabs.Panel", [pie, counts], {id: "provider"})',
    ].join("\n"),
  );
  const errors: string[] = [];
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  globalThis.fetch = (async () => Response.json({ columns: ["provider", "count"], rows: [{ provider: "phone", count: 103 }, { provider: "wechat", count: 55 }], rowCount: 2, truncated: false })) as typeof fetch;
  const events: unknown[] = [{ type: "start", messageId: "repro" }, { type: "text-start", id: "text" }];
  for (let index = 0; index < replayProgram.length; index += 3) events.push({ type: "text-delta", id: "text", delta: replayProgram.slice(index, index + 3) });
  events.push({ type: "text-end", id: "text" }, { type: "finish" });
  const transport = new DefaultChatTransport({
    fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    }),
  });
  let status = "submitted";
  let responseLength = 0;
  let updates = 0;
  function Replay() {
    // Intentionally unthrottled to exercise the original failure, even though
    // Studio now coalesces messages. All chunks arrive in the same task.
    const chat = useChat({ transport, onError: error => errors.push(error.stack ?? error.message) });
    const started = useRef(false);
    useEffect(() => {
      if (!started.current) { started.current = true; void chat.sendMessage({ text: "Replay" }); }
    }, []);
    const response = chat.messages.at(-1)?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
    status = chat.status;
    responseLength = response.length;
    updates++;
    return <AnalysisView response={response} isStreaming={status === "streaming" || status === "submitted"} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(predicate()).toBe(true);
  };
  try {
    root.render(<Replay />);
    await waitUntil(() => status === "error" || (status === "ready" && responseLength === replayProgram.length));
    expect(errors.filter(error => /maximum update|REPRO|render failed/i.test(error))).toEqual([]);
    expect(status).toBe("ready");
    expect(responseLength).toBe(replayProgram.length);
    expect(updates).toBeGreaterThan(50);
    await waitUntil(() => !!container.querySelector('[data-evilcharts-chart="bar"]'));
    expect(container.textContent).toContain("Completed stream");
    const providerTab = container.querySelector<HTMLElement>('[role="tab"][data-key="provider"]');
    expect(providerTab).not.toBeNull();
    providerTab!.click();
    await waitUntil(() => container.querySelector('[role="tab"][data-key="provider"]')?.getAttribute("aria-selected") === "true");
    await waitUntil(() => container.textContent?.includes("wechat") === true);
    expect(container.querySelector("[inert]")).toBeNull();
    expect(errors.filter(error => /maximum update/i.test(error))).toEqual([]);
  } finally {
    root.unmount();
    container.remove();
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
}, 15000);

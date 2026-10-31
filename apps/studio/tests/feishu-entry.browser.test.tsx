import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://studio.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "SVGElement", "MutationObserver", "NodeFilter", "DocumentFragment", "CustomEvent", "Event"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, { matchMedia: dom.window.matchMedia, localStorage: dom.window.localStorage, customElements: dom.window.customElements, CSSStyleSheet: dom.window.CSSStyleSheet, DOMRect: dom.window.DOMRect, DOMRectReadOnly: dom.window.DOMRectReadOnly });
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { value: () => new dom.window.DOMRect(0, 0, 800, 600) });
Object.defineProperty(dom.window.HTMLElement.prototype, "getAnimations", { value: () => [] });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value: () => {} });

const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Routes, Route } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { StudioRouteShell } = await import("../src/client/layout/studio-route-shell");
const { StudioThemeProvider } = await import("../src/client/studio-theme");
afterAll(() => dom.window.close());

test.each(["/", "/feishu"])("%s renders only its source controls and only Feishu requests consent", async (path) => {
  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); fetched.push(url);
    if (url === "/api/threads") return Response.json({ threads: [] });
    if (url === "/api/feishu") return Response.json({ available: true, connected: false, configured: false, callbackPath: "/api/feishu/callback" });
    if (url === "/api/meta") return Response.json({ protocolVersion: 1, capabilities: { chat: false } });
    if (url === "/api/catalog") return Response.json({ catalog: { schemas: [], dialect: "postgres", databaseName: "test", fingerprint: "test" } });
    if (url === "/api/connection") return Response.json({ connection: { connected: false, dialect: "postgres", warnings: [] } });
    if (url === "/api/settings") return Response.json({ settings: { database: { urlConfigured: false }, llm: { provider: "openrouter", model: "test/model", apiKeyConfigured: false, apiKeySource: "none" } } });
    return Response.json({});
  }) as typeof fetch;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };
  try {
    root.render(<QueryClientProvider client={client}><StudioThemeProvider><MemoryRouter initialEntries={[path]}><Routes><Route element={<StudioRouteShell />}><Route path="*" element={<div>Chat surface</div>} /></Route></Routes></MemoryRouter></StudioThemeProvider></QueryClientProvider>);
    await until(() => fetched.includes("/api/settings"));
    if (path === "/feishu") {
      await until(() => document.body.textContent?.includes("连接飞书文档") === true);
      expect(container.querySelector('[aria-label="Open database explorer"]')).toBeNull();
      expect(fetched).not.toContain("/api/catalog");
      expect(fetched).not.toContain("/api/connection");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    } else {
      expect(container.querySelector('[aria-label="Open database explorer"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain("飞书");
      expect(fetched).not.toContain("/api/feishu");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  } finally {
    root.unmount(); client.clear(); container.remove(); globalThis.fetch = originalFetch;
  }
});

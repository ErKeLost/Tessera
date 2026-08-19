import { describe, expect, test } from "bun:test";
import {
  safeParseBuiltInArtifactActionEvent,
  type ArtifactActionEvent,
  type InsightArtifact as InsightArtifactData,
  type MetricArtifact as MetricArtifactData,
} from "@data-elements/schema";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactUIProvider,
  DataElementsProvider,
  useArtifactAction,
  useArtifactActionAvailability,
  type ArtifactCommandTransport,
} from "./bridge";
import { InsightArtifact } from "./insight-artifact";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "./primitives";
import {
  ArtifactRenderer,
  createRendererRegistry,
  defaultRendererRegistry,
  defineArtifactRenderer,
  extendRendererRegistry,
  type ArtifactRendererErrorBoundaryProps,
  type ArtifactRendererValueGuard,
} from "./renderer";

const metricArtifact: MetricArtifactData = {
  protocolVersion: "1.0",
  id: "metric-revenue",
  kind: "metric",
  title: "Revenue",
  description: "Current revenue",
  metrics: [
    {
      id: "revenue",
      label: "Revenue",
      value: 125_000,
      format: "currency",
      currency: "USD",
    },
  ],
};

const insightArtifact: InsightArtifactData = {
  protocolVersion: "1.0",
  id: "insight-retention",
  kind: "insight",
  title: "Retention insight",
  description: "A useful observation",
  insights: [
    {
      id: "retention",
      headline: "Retention improved",
      detail: "Seven-day retention rose.",
    },
  ],
  recommendedAction: "Investigate retention",
};

const queryActionSource = { id: "query-revenue", kind: "query" } as const;

describe("renderer registry", () => {
  test("keeps every official renderer when applying overrides", () => {
    const expectedKinds = [
      "anomaly",
      "breakdown",
      "calculator",
      "cohort",
      "comparison",
      "data-quality",
      "distribution",
      "driver",
      "experiment",
      "forecast",
      "funnel",
      "insight",
      "metric",
      "query",
      "ranking",
      "target",
      "timeline",
      "trend",
    ];
    const MetricOverride = defineArtifactRenderer<MetricArtifactData>(
      ({ value }) => <p>Override: {value.title}</p>,
    );
    const registry = createRendererRegistry({ metric: MetricOverride });

    expect(Object.keys(defaultRendererRegistry).sort()).toEqual(expectedKinds);
    expect(Object.keys(registry).sort()).toEqual(expectedKinds);
    expect(registry.metric).toBe(MetricOverride);
    expect(registry.query).toBe(defaultRendererRegistry.query);
  });

  test("supports artifact and value props plus guarded string kinds", () => {
    const fromArtifact = renderToStaticMarkup(
      <ArtifactRenderer artifact={metricArtifact} />,
    );
    const fromValue = renderToStaticMarkup(
      <ArtifactRenderer value={metricArtifact} />,
    );
    expect(fromArtifact).toContain("Revenue");
    expect(fromValue).toContain("Revenue");

    type NoteValue = { kind: "custom.note"; message: string };
    const NoteRenderer = defineArtifactRenderer<NoteValue>(({ value }) => (
      <output>{value.message}</output>
    ));
    const noteGuard: ArtifactRendererValueGuard<NoteValue> = {
      is: (value): value is NoteValue =>
        Boolean(
          value &&
          typeof value === "object" &&
          (value as { kind?: unknown }).kind === "custom.note",
        ),
      getKind: (value) => value.kind,
    };
    const registry = extendRendererRegistry(createRendererRegistry(), {
      "custom.note": NoteRenderer,
    });
    const customMarkup = renderToStaticMarkup(
      <ArtifactRenderer
        registry={registry}
        value={{ kind: "custom.note", message: "Guarded extension" }}
        valueGuards={[noteGuard]}
      />,
    );
    expect(customMarkup).toContain("Guarded extension");
  });

  test("makes a single metric span its available grid width", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer artifact={metricArtifact} />,
    );
    expect(markup).toContain("de-metric-grid de-metric-grid-single");
  });

  test("uses custom unsupported and error-boundary surfaces", () => {
    const fallbackMarkup = renderToStaticMarkup(
      <ArtifactRenderer
        fallback={({ kind }) => <p>Unsupported: {kind}</p>}
        value={{ kind: "untrusted" }}
      />,
    );
    expect(fallbackMarkup).toContain("Unsupported: untrusted");

    function Boundary({ children, kind }: ArtifactRendererErrorBoundaryProps) {
      return <aside data-boundary={kind}>{children}</aside>;
    }
    const boundaryMarkup = renderToStaticMarkup(
      <ArtifactRenderer artifact={metricArtifact} errorBoundary={Boundary} />,
    );
    expect(boundaryMarkup).toContain('data-boundary="metric"');
  });
});

describe("provider theme and semantic slots", () => {
  test("writes stable slots, theme name, CSS variables, and merged classes during SSR", () => {
    const markup = renderToStaticMarkup(
      <ArtifactUIProvider
        slotClasses={{ artifact: "host-root", "artifact-title": "host-title" }}
        theme={{
          name: "operations",
          variables: { "--artifact-accent": "oklch(0.62 0.2 145)" },
        }}
      >
        <Artifact className="instance-root">
          <ArtifactHeader>
            <div>
              <ArtifactTitle className="instance-title">
                Pipeline health
              </ArtifactTitle>
              <ArtifactDescription>Production</ArtifactDescription>
            </div>
          </ArtifactHeader>
          <ArtifactContent>Ready</ArtifactContent>
        </Artifact>
      </ArtifactUIProvider>,
    );

    expect(markup).toContain('data-slot="artifact"');
    expect(markup).toContain('class="de-theme"');
    expect(markup).toContain('data-slot="artifact-header"');
    expect(markup).toContain('data-slot="artifact-title"');
    expect(markup).toContain('data-slot="artifact-content"');
    expect(markup).toContain('data-theme="operations"');
    expect(markup).toContain("--artifact-accent:oklch(0.62 0.2 145)");
    expect(markup).toContain("host-root instance-root");
    expect(markup).toContain("host-title instance-title");
  });

  test("merges nested provider theme and slot settings", () => {
    const markup = renderToStaticMarkup(
      <ArtifactUIProvider
        slotClasses={{ artifact: "outer-root" }}
        theme={{ name: "outer", variables: { "--outer-token": "1" } }}
      >
        <ArtifactUIProvider
          cssVariables={{ "--inner-token": "2" }}
          slotClasses={{ "artifact-title": "inner-title" }}
        >
          <Artifact>
            <ArtifactTitle>Nested</ArtifactTitle>
          </Artifact>
        </ArtifactUIProvider>
      </ArtifactUIProvider>,
    );
    expect(markup).toContain('data-theme="outer"');
    expect(markup).toContain("--outer-token:1");
    expect(markup).toContain("--inner-token:2");
    expect(markup).toContain("outer-root");
    expect(markup).toContain("inner-title");
  });
});

describe("action bridge", () => {
  test("fails closed for brokered actions without a command channel", async () => {
    let dispatch: ReturnType<typeof useArtifactAction> | undefined;

    function Probe() {
      dispatch = useArtifactAction(queryActionSource);
      const available = useArtifactActionAvailability(
        metricArtifact,
        "export-query",
        { brokered: true },
      );
      return <span>{available ? "available" : "unavailable"}</span>;
    }

    const markup = renderToStaticMarkup(<Probe />);
    expect(markup).toContain("unavailable");
    await dispatch?.("export-query", { format: "csv" }, { brokered: true });
  });

  test("dispatches through transport and honors transport availability", async () => {
    const events: ArtifactActionEvent[] = [];
    let dispatch: ReturnType<typeof useArtifactAction> | undefined;
    const transport: ArtifactCommandTransport = {
      canDispatch: ({ action }) => action === "export-query",
      dispatch(event) {
        events.push(event);
      },
    };

    function Probe() {
      dispatch = useArtifactAction(queryActionSource);
      const available = useArtifactActionAvailability(
        metricArtifact,
        "export-query",
        { brokered: true },
      );
      const denied = useArtifactActionAvailability(
        metricArtifact,
        "delete-query",
        { brokered: true },
      );
      return (
        <span>
          {available ? "available" : "unavailable"}/
          {denied ? "allowed" : "denied"}
        </span>
      );
    }

    const markup = renderToStaticMarkup(
      <ArtifactUIProvider transport={transport}>
        <Probe />
      </ArtifactUIProvider>,
    );
    expect(markup).toContain("available/denied");
    await dispatch?.("export-query", { format: "csv" }, { brokered: true });
    await dispatch?.("delete-query", {}, { brokered: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "export-query",
      artifactId: queryActionSource.id,
      payload: { format: "csv" },
    });
    expect(safeParseBuiltInArtifactActionEvent(events[0]).success).toBe(true);
  });

  test("retains DataElementsProvider onAction compatibility", async () => {
    const events: ArtifactActionEvent[] = [];
    let dispatch: ReturnType<typeof useArtifactAction> | undefined;

    function Probe() {
      dispatch = useArtifactAction(metricArtifact);
      return null;
    }

    renderToStaticMarkup(
      <DataElementsProvider
        onAction={(event) => {
          events.push(event);
        }}
      >
        <Probe />
      </DataElementsProvider>,
    );
    await dispatch?.("metric-select", { metricId: "revenue" });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("metric-select");
  });

  test("rejects built-in payload and kind mismatches before transport dispatch", async () => {
    const events: ArtifactActionEvent[] = [];
    let dispatch: ReturnType<typeof useArtifactAction> | undefined;
    let wrongKindDispatch: ReturnType<typeof useArtifactAction> | undefined;

    function Probe() {
      dispatch = useArtifactAction(queryActionSource);
      wrongKindDispatch = useArtifactAction(metricArtifact);
      return null;
    }

    renderToStaticMarkup(
      <ArtifactUIProvider
        transport={(event) => {
          events.push(event);
        }}
      >
        <Probe />
      </ArtifactUIProvider>,
    );
    const result = dispatch!(
      "export-query",
      { format: "json" as "csv" },
      { brokered: true },
    );
    await expect(Promise.resolve(result)).rejects.toThrow();
    const wrongKindResult = wrongKindDispatch!(
      "export-query",
      { format: "csv" },
      { brokered: true },
    );
    await expect(Promise.resolve(wrongKindResult)).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  test("keeps valid custom action names extensible", async () => {
    const events: ArtifactActionEvent[] = [];
    let dispatch: ReturnType<typeof useArtifactAction> | undefined;

    function Probe() {
      dispatch = useArtifactAction(metricArtifact);
      return null;
    }

    renderToStaticMarkup(
      <ArtifactUIProvider
        transport={(event) => {
          events.push(event);
        }}
      >
        <Probe />
      </ArtifactUIProvider>,
    );
    await dispatch?.(
      "acme.open-detail",
      { route: "revenue" },
      { brokered: true },
    );
    expect(events[0]).toMatchObject({
      action: "acme.open-detail",
      payload: { route: "revenue" },
    });
  });

  test("does not advertise brokered calls to action without transport", () => {
    const staticMarkup = renderToStaticMarkup(
      <InsightArtifact artifact={insightArtifact} />,
    );
    const connectedMarkup = renderToStaticMarkup(
      <ArtifactUIProvider transport={() => undefined}>
        <InsightArtifact artifact={insightArtifact} />
      </ArtifactUIProvider>,
    );
    expect(staticMarkup).not.toContain("Investigate retention");
    expect(connectedMarkup).toContain("Investigate retention");
  });
});

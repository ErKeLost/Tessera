import { describe, expect, test } from "bun:test";
import { Renderer, createParser } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { heroChatLibrary } from "./index";
import { HEROUI_COMPONENTS, HEROUI_NATIVE_COMPONENT_NAMES, safeHeroOptions } from "./native-catalog";

function render(program: string, initialState?: Record<string, unknown>) {
  return renderToStaticMarkup(<Renderer library={heroChatLibrary} response={program} initialState={initialState} />);
}

describe("HeroUI answer library", () => {
  test("exposes the complete official 72-component inventory and compound parts", () => {
    expect(HEROUI_COMPONENTS).toHaveLength(72);
    const schema = heroChatLibrary.components.HeroUI!.props.shape.component;
    for (const name of HEROUI_COMPONENTS) expect(schema.safeParse(name).success).toBe(true);
    for (const name of ["DateRangePicker.Popover", "ColorPicker.Trigger", "Table.Column", "Typography.Heading", "InputOTP.Slot"]) expect(HEROUI_NATIVE_COMPONENT_NAMES).toContain(name);
    expect(schema.safeParse("div").success).toBe(false);
    for (const name of ["BarChart", "LineChart", "AreaChart", "ComposedChart", "PieChart", "RadarChart", "RadialChart", "SankeyChart", "FlowNode", "FlowLink"]) {
      expect(heroChatLibrary.components[name]).toBeDefined();
    }
  });

  test("renders legacy compact signatures with native HeroUI controls", () => {
    const html = render('root = Card([header, table, alert, actions])\nheader = CardHeader("Orders", "Live data")\ntable = Table([Col("Status", "string"), Col("Count", "number")], [["paid", 77]])\nalert = Alert("Ready", "Loaded", "success")\nactions = Buttons([Button("Refresh", @ToAssistant("Refresh"))])');
    expect(html).toContain("card__content");
    expect(html).toContain("table__cell");
    expect(html).toContain("button--primary");
    expect(html).toContain("77");
  });

  test("parses chart DSL and renders through installed EvilCharts components", () => {
    const program = [
      "root = Card([bar, line, area, composed, pie, radar, radial, sankey])",
      'bar = BarChart(["Sep", "Oct"], [Series("Users", [148, 43])])',
      'line = LineChart(["Sep", "Oct"], [Series("Users", [148, 43])])',
      'area = AreaChart(["Sep", "Oct"], [Series("Users", [148, 43])])',
      'composed = ComposedChart(["Sep", "Oct"], [Series("Users", [148, 43]), Series("Revenue", [17, 22])])',
      'pie = PieChart([Slice("Phone", 103), Slice("WeChat", 55)], true)',
      'radar = RadarChart(["Growth", "Retention"], [Series("Product", [80, 70])])',
      'radial = RadialChart([Slice("Phone", 103), Slice("WeChat", 55)])',
      'sankey = SankeyChart([FlowNode("Impressions"), FlowNode("Clicks"), FlowNode("Orders")], [FlowLink("Impressions", "Clicks", 420), FlowLink("Clicks", "Orders", 86)])',
    ].join("\n");
    const parsed = createParser(heroChatLibrary.toJSONSchema(), heroChatLibrary.root).parse(program);
    const html = render(program);

    expect(parsed.meta.errors).toEqual([]);
    expect(html).toContain('data-evilcharts-chart="bar"');
    expect(html).toContain('data-evilcharts-chart="line"');
    expect(html).toContain('data-evilcharts-chart="area"');
    expect(html).toContain('data-evilcharts-chart="composed"');
    expect(html).toContain('data-evilcharts-chart="pie"');
    expect(html).toContain('data-evilcharts-chart="radar"');
    expect(html).toContain('data-evilcharts-chart="radial"');
    expect(html).toContain('data-evilcharts-chart="sankey"');
    expect(heroChatLibrary.toSpec().components.SankeyChart?.signature).toContain("FlowLink[]");
    expect(heroChatLibrary.toSpec().components.BarChart?.signature).toContain("Series[]");
  });

  test("renders EvilCharts-backed bar, line and pie chart signatures", () => {
    const html = render([
      "root = Card([bars, lines, pie])",
      'bars = BarChart(["Sep", "Oct"], [Series("Registrations", [148, 43])])',
      'lines = LineChart(["Sep", "Oct"], [Series("Registrations", [148, 43])])',
      'pie = PieChart([Slice("Phone", 103), Slice("WeChat", 55)], true)',
    ].join("\n"));

    expect(html).toContain('data-evilcharts-chart="bar"');
    expect(html).toContain('data-evilcharts-chart="line"');
    expect(html).toContain('data-evilcharts-chart="pie"');
  });

  test("OpenUI Table resolves Col references into columns and row cells", () => {
    const parsed = createParser(heroChatLibrary.toJSONSchema(), heroChatLibrary.root).parse(
      'root = Card([table])\ntable = Table([Col("Month", "string"), Col("Users", "number")], [["2026-09", 148], ["2026-10", 43]])',
    );
    const card = parsed.root as unknown as { props: { children: Array<{ typeName: string; props: Record<string, unknown> }> } };
    const table = card.props.children[0];

    expect(table).toMatchObject({
      typeName: "Table",
      props: {
        columns: [
          { typeName: "Col", props: { header: "Month", type: "string" } },
          { typeName: "Col", props: { header: "Users", type: "number" } },
        ],
        rows: [["2026-09", 148], ["2026-10", 43]],
      },
    });
  });

  test("renders a chart followed by a dense details table", () => {
    const rows = Array.from({ length: 10 }, (_, index) => (
      `["Note ${index + 1}", "Creator ${index + 1}", ${1000 - index * 25}, ${12000 - index * 120}, ${900 - index * 20}, "12.5%", ${2400 - index * 50}, 2.4]`
    )).join(", ");
    const program = [
      "root = Card([chart, title, details])",
      'chart = BarChart(["Sep", "Oct"], [Series("Spend", [148, 43])])',
      'title = TextContent("TOP10 details", "large-heavy")',
      `details = Table([Col("Note", "string"), Col("Creator", "string"), Col("Spend", "number"), Col("Impressions", "number"), Col("Clicks", "number"), Col("CTR", "string"), Col("GMV", "number"), Col("ROI", "number")], [${rows}])`,
    ].join("\n");
    const html = render(program);

    expect(html).toContain('data-evilcharts-chart="bar"');
    expect(html).toContain("TOP10 details");
    expect(html).toContain("Note 10");
    expect(html).toContain("Creator 10");
  });

  test("defers expensive EvilCharts SVG work while the answer streams", () => {
    const html = renderToStaticMarkup(
      <Renderer
        isStreaming
        library={heroChatLibrary}
        response={'root = Card([chart])\nchart = BarChart(["Sep", "Oct"], [Series("Spend", [148, 43])])'}
      />,
    );

    expect(html).toContain('data-evilcharts-placeholder="bar"');
    expect(html).not.toContain("recharts-bar");
  });

  test("renders a static chart inside tabs without a query loading gate", () => {
    const html = render([
      "root = Card([tabs])",
      'tabs = Tabs([monthTab], "month")',
      'monthTab = TabItem("month", "月度趋势", [chart])',
      'chart = BarChart(["2026-09", "2026-10"], [Series("注册用户", [148, 43])])',
    ].join("\n"));

    expect(html).toContain('data-evilcharts-chart="bar"');
    expect(html).not.toContain('data-evilcharts-placeholder="bar"');
  });

  test("keeps Tabs tab items distinct from Accordion items in the OpenUI schema", () => {
    const program = 'root = Card([tabs])\ntabs = Tabs([monthTab, channelTab], "month")\nmonthTab = TabItem("month", "按月份", [TextContent("Monthly totals")])\nchannelTab = TabItem("channel", "按渠道", [TextContent("Provider totals")])';
    const parsed = createParser(heroChatLibrary.toJSONSchema(), heroChatLibrary.root).parse(program);
    const html = render(program);

    expect(heroChatLibrary.toSpec().components.Tabs?.signature).toContain("TabItem[]");
    expect(parsed.meta.errors).toEqual([]);
    expect(html).toContain("按月份");
    expect(html).toContain("Monthly totals");
  });

  test("native compound number input accepts a reactive variable", () => {
    const program = 'root = Card([field, text])\n$limit = 20\nfield = HeroUI("NumberField", [group], {"aria-label": "Result limit"}, "limit", $limit)\ngroup = HeroUI("NumberField.Group", [input])\ninput = HeroUI("NumberField.Input", [])\ntext = TextContent("Limit: " + $limit)';
    const html = render(program, { $limit: 7 });
    // OpenUI hydrates its reactive store in an effect; SSR only verifies the structure.
    expect(html).toContain("number-field__input");
    expect(html).toContain('name="limit"');
    expect(heroChatLibrary.toSpec().components.HeroUI?.signature).toContain("$binding");
    expect(createParser(heroChatLibrary.toJSONSchema(), "Card").parse(program).root).not.toBeNull();
  });

  test("native collection parts work through the OpenUI renderer", () => {
    const html = render('root = Card([list])\nlist = HeroUI("ListBox", [item], {"aria-label": "Regions"})\nitem = HeroUI("ListBox.Item", ["Europe"], {id: "eu", textValue: "Europe"})');
    expect(html).toContain("Europe");
    expect(html).toContain("list-box");
  });

  test("native calendar render functions are provided by the host", () => {
    const html = render('root = Card([cal])\ncal = HeroUI("Calendar", [grid], {"aria-label": "Date"}, "date", $date)\n$date = "2026-10-28"\ngrid = HeroUI("Calendar.Grid", [head, body])\nhead = HeroUI("Calendar.GridHeader", [])\nbody = HeroUI("Calendar.GridBody", [])');
    expect(html).toContain("calendar__cell");
    expect(html).toContain("2026");
  });

  test("does not pass executable or HTML injection options to native components", () => {
    expect(safeHeroOptions({ onPress: "execute", render: "code", dangerouslySetInnerHTML: { __html: "unsafe" }, href: "javascript:alert(1)", variant: "primary", "aria-label": "Save" })).toEqual({ variant: "primary", "aria-label": "Save" });
  });
});

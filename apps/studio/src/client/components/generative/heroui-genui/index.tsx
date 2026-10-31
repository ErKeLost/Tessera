"use client";

import {
  Accordion, Alert, Avatar, Button, Card, Chip, Label, ProgressBar,
  Separator, Skeleton, Spinner, Table, Tabs,
  Form,
  ButtonGroup,
} from "@heroui/react";
import { useMemo } from "react";
import { createLibrary, defineComponent, FormNameContext, FormValidationContext, reactive, useCreateFormValidation, useIsStreaming, useStateField, useTriggerAction, type PromptOptions } from "@openuidev/react-lang";
import { z } from "zod";
import { heroSchemas } from "./schemas";
import { TextContent } from "../shadcn-genui/components/text-content";
import { MarkDownRenderer } from "../shadcn-genui/components/markdown-renderer";
import { CodeBlock } from "../shadcn-genui/components/code-block";
import { Image, ImageBlock } from "../shadcn-genui/components/image";
import { Heading, Blockquote, InlineCode } from "../shadcn-genui/components/typography";
import { answerFunctions } from "../shadcn-genui/functions";
import { answerActions } from "../shadcn-genui/actions";
import { HeroButton, HeroInput, HeroTextArea, HeroSelect, HeroFormControl } from "./controls";
import { HeroCheckBoxGroup, HeroRadioGroup, HeroSwitchGroup, HeroSlider } from "./selection";
import { HeroDatePicker, HeroDialog, HeroDrawer, HeroPagination, HeroPopover, HeroTooltip } from "./overlays";
import { HeroNative } from "./native-catalog";
import {
  AreaChart,
  BarChart,
  ComposedChart,
  LineChart,
  PieChart,
  RadarChart,
  RadialChart,
  SankeyChart,
  FlowNode,
  FlowLink,
  Series,
  Slice,
} from "./charts";

const base = heroSchemas;
const renderEmptyTableState = () => "No rows";

const HeroCard = defineComponent({
  ...base.Card!,
  component: ({ props, renderNode }) => (
    <Card data-slot="card"><Card.Content className="space-y-5">{renderNode(props.children)}</Card.Content></Card>
  ),
});

const HeroCardHeader = defineComponent({
  ...base.CardHeader!,
  component: ({ props }) => (
    <Card.Header><Card.Title>{props.title}</Card.Title>{props.description ? <Card.Description>{props.description}</Card.Description> : null}</Card.Header>
  ),
});

const HeroAlert = defineComponent({
  ...base.Alert!,
  component: ({ props }) => (
    <Alert data-slot="alert" status={props.variant === "destructive" ? "danger" : props.variant === "info" ? "accent" : props.variant ?? "default"}>
      <Alert.Indicator /><Alert.Content><Alert.Title>{props.title}</Alert.Title><Alert.Description>{props.description}</Alert.Description></Alert.Content>
    </Alert>
  ),
});

function chipColor(variant: unknown) { return variant === "destructive" ? "danger" : variant === "default" ? "accent" : "default"; }

const HeroBadge = defineComponent({
  ...base.Badge!,
  component: ({ props }) => <Chip data-slot="badge" color={chipColor(props.variant)}>{props.text}</Chip>,
});
const HeroTag = defineComponent({
  ...base.Tag!,
  component: ({ props }) => <Chip data-slot="badge" color={chipColor(props.variant)}>{props.text}</Chip>,
});
const HeroTagBlock = defineComponent({
  ...base.TagBlock!,
  component: ({ props }) => (
    <div className="flex flex-wrap gap-1.5">{(props.tags ?? []).map((tag: string | { props?: { text?: string; variant?: string } }, index: number) => (
      <Chip data-slot="badge" key={index} color={chipColor(typeof tag === "string" ? "secondary" : tag.props?.variant)}>{typeof tag === "string" ? tag : tag.props?.text ?? ""}</Chip>
    ))}</div>
  ),
});
const HeroAvatar = defineComponent({
  ...base.Avatar!,
  component: ({ props }) => <Avatar>{props.src ? <Avatar.Image src={props.src} alt={props.alt ?? ""} /> : null}<Avatar.Fallback>{props.fallback}</Avatar.Fallback></Avatar>,
});
const HeroProgress = defineComponent({
  ...base.Progress!,
  component: ({ props }) => (
    <ProgressBar value={props.value} aria-label={props.label ?? "Progress"}>
      {props.label ? <Label>{props.label}</Label> : null}<ProgressBar.Output /><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
    </ProgressBar>
  ),
});
const HeroSeparator = defineComponent({ ...base.Separator!, component: ({ props }) => <Separator orientation={props.orientation} /> });
const HeroLabel = defineComponent({ ...base.Label!, component: ({ props }) => <Label htmlFor={props.htmlFor}>{props.text}</Label> });

const HeroTable = defineComponent({
  ...base.Table!,
  component: ({ props }) => {
    const columns = useMemo(() => {
      const sourceColumns = (props.columns ?? []) as Array<{ props?: { header?: unknown; type?: unknown } }>;
      const sourceRows = (props.rows ?? []) as unknown[][];
      const columnCount = Math.max(sourceColumns.length, ...sourceRows.map((row) => row.length), 0);
      return Array.from({ length: columnCount }, (_, index) => {
        const source = sourceColumns[index]?.props;
        return {
          id: `column-${index}`,
          header: typeof source?.header === "string" ? source.header : `Column ${index + 1}`,
          type: source?.type === "number" ? "number" : "string",
        };
      });
    }, [props.columns, props.rows]);
    const rows = useMemo(() => ((props.rows ?? []) as unknown[][]).map((cells, index) => ({
      id: `row-${index}`,
      cells: columns.map((_, cellIndex) => cells[cellIndex]),
    })), [props.rows, columns]);
    const headerCells = useMemo(() => columns.map((column) => (
      <Table.Column key={column.id} id={column.id} isRowHeader={column.id === columns[0]?.id} className={column.type === "number" ? "text-right" : undefined}>
        {column.header}
      </Table.Column>
    )), [columns]);
    const bodyRows = useMemo(() => rows.map((row) => (
      <Table.Row key={row.id} id={row.id}>{row.cells.map((cell, index) => (
        <Table.Cell key={columns[index]?.id} className={columns[index]?.type === "number" ? "text-right tabular-nums" : undefined}>
          {String(cell ?? "")}
        </Table.Cell>
      ))}</Table.Row>
    )), [rows, columns]);
    if (columns.length === 0) return null;
    return (
      <Table data-slot="table"><Table.ScrollContainer><Table.Content aria-label="Analysis results">
        <Table.Header>{headerCells}</Table.Header>
        <Table.Body renderEmptyState={renderEmptyTableState}>{bodyRows}</Table.Body>
      </Table.Content></Table.ScrollContainer></Table>
    );
  },
});

const HeroTabs = defineComponent({
  ...base.Tabs!,
  props: base.Tabs!.props.extend({ value: reactive(z.string().optional()) }),
  description: base.Tabs!.description + " Optional value binds the selected tab to a $variable.",
  component: ({ props, renderNode }) => {
    const items = (props.items ?? []).filter((item: { props?: { value?: string; trigger?: string } }) => item?.props?.value && item?.props?.trigger);
    const field = useStateField("tabs", props.value);
    const streaming = useIsStreaming();
    const preferred = field.value ?? props.defaultValue ?? items[0]?.props.value;
    const selected = items.some((item: { props: { value: string } }) => item.props.value === preferred) ? preferred : items[0]?.props.value;
    if (items.length === 0) return null;
    // Disabling a selected React Aria tab while its collection streams causes
    // competing focus effects. Inert blocks interaction without changing the
    // selection/focus state (see tests/openui-stream.browser.test.tsx).
    return (
      <div inert={streaming || undefined} aria-busy={streaming || undefined}>
        <Tabs selectedKey={selected} onSelectionChange={(key) => {
          if (!streaming && String(key) !== selected) field.setValue(String(key));
        }}>
          <Tabs.ListContainer><Tabs.List aria-label="Analysis views">{items.map((item: { props: { value: string; trigger: string } }) => <Tabs.Tab key={item.props.value} id={item.props.value}>{item.props.trigger}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
          {items.map((item: { props: { value: string; content: unknown } }) => <Tabs.Panel key={item.props.value} id={item.props.value} className="space-y-3">{renderNode(item.props.content)}</Tabs.Panel>)}
        </Tabs>
      </div>
    );
  },
});

const HeroAccordion = defineComponent({
  ...base.Accordion!,
  component: ({ props, renderNode }) => (
    <Accordion allowsMultipleExpanded={props.type !== "single"} isDisabled={useIsStreaming()}>
      {(props.items ?? []).map((item: { props?: { value?: string; trigger?: string; content?: unknown } }, index: number) => (
        <Accordion.Item key={index} id={item.props?.value ?? String(index)}><Accordion.Heading><Accordion.Trigger>{item.props?.trigger}<Accordion.Indicator /></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body>{renderNode(item.props?.content)}</Accordion.Body></Accordion.Panel></Accordion.Item>
      ))}
    </Accordion>
  ),
});

const HeroFollowUpBlock = defineComponent({
  ...base.FollowUpBlock!,
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const streaming = useIsStreaming();
    return <div className="flex flex-wrap gap-2">{(props.items ?? []).map((item: { props?: { text?: string } }, index: number) => {
      const text = String(item.props?.text ?? "");
      return <Button key={index} variant="outline" size="sm" isDisabled={streaming || !text.trim()} onPress={() => trigger(text)}>{text}</Button>;
    })}</div>;
  },
});
const HeroSpinner = defineComponent({
  ...base.SpinnerBlock!,
  component: ({ props }) => <div className="flex items-center gap-2" role="status"><Spinner size="sm" />{props.label ? <span>{props.label}</span> : null}</div>,
});
const HeroSkeleton = defineComponent({
  ...base.SkeletonBlock!,
  component: ({ props }) => <div className="space-y-2" aria-hidden="true">{Array.from({ length: Math.max(1, Math.min(12, Math.floor(Number(props.lines) || 3))) }, (_, index) => <Skeleton key={index} className="h-4 w-full" />)}</div>,
});
const HeroButtons = defineComponent({
  ...base.Buttons,
  component: ({ props, renderNode }) => <ButtonGroup className={props.direction === "column" ? "flex-col" : "flex-wrap"}>{renderNode(props.buttons)}</ButtonGroup>,
});
const HeroForm = defineComponent({
  ...base.Form,
  component: ({ props, renderNode }) => {
    const validation = useCreateFormValidation();
    return <FormValidationContext.Provider value={validation}><FormNameContext.Provider value={props.name}>
      <Form className="space-y-4" onSubmit={(event) => event.preventDefault()}>{renderNode(props.fields)}{renderNode(props.buttons)}</Form>
    </FormNameContext.Provider></FormValidationContext.Provider>;
  },
});

/**
 * One independent library owns both the prompt and native HeroUI rendering.
 * The previous shadcn registry and its chart engine do not enter this runtime.
 */
const overrides = [
  HeroCard, HeroCardHeader, HeroAlert, HeroBadge, HeroTag, HeroTagBlock, HeroAvatar,
  HeroProgress, HeroSeparator, HeroLabel, HeroTable, HeroTabs, HeroAccordion,
  HeroButton, HeroInput, HeroTextArea, HeroSelect, HeroFormControl,
  HeroCheckBoxGroup, HeroRadioGroup, HeroSwitchGroup, HeroSlider,
  HeroFollowUpBlock, HeroSpinner, HeroSkeleton,
  HeroDatePicker, HeroDialog, HeroDrawer, HeroPagination, HeroPopover, HeroTooltip,
  HeroButtons, HeroForm,
  BarChart, LineChart, AreaChart, ComposedChart, PieChart, RadarChart, RadialChart, SankeyChart,
];
// Only native HeroUI controls and the product's content/chart renderers are
// callable. No shadcn control is retained as a runtime fallback.
export const heroChatLibrary = createLibrary({
  root: "Card",
  functions: answerFunctions,
  actions: answerActions,
  components: [
    ...overrides, HeroNative,
    TextContent, MarkDownRenderer, CodeBlock, Image, ImageBlock, Heading, Blockquote, InlineCode,
    base.Col, Series, Slice, FlowNode, FlowLink, base.SelectItem, base.CheckBoxItem, base.RadioItem, base.SwitchItem,
    base.FollowUpItem, base.TabItem, base.AccordionItem,
  ],
});

export const heroPromptOptions: PromptOptions = {
  additionalRules: [
    "Every response is a single Card(children); children stack vertically. Use Tabs for multiple views, Accordion for optional detail.",
    "Use EvilCharts-powered BarChart, LineChart, AreaChart, ComposedChart, PieChart, RadarChart, RadialChart or SankeyChart when a chart makes a comparison, trend or flow easier to read. For category/value charts use Slice references; for series charts use Series references; for flows use FlowNode names and FlowLink source/target names that match exactly.",
    "BarChart arguments are positional: BarChart(labels, series, variant, xLabel, yLabel). When providing axis labels always pass \"grouped\" or \"stacked\" as the third argument; never put an axis label in the variant position.",
    "Use CardHeader for titles, TextContent for plain text, MarkDownRenderer for formatted explanations, and CodeBlock for copyable code.",
    "Use the registered Button variants: default, secondary, outline, ghost, link, destructive; the host maps these to HeroUI's semantic variants.",
    "Use Form with one FormControl per field and Buttons as its second argument. Never nest forms.",
    "Use FollowUpBlock at the end for questions that require new reasoning. Use @CopyText for reusable values.",
    "Use @Percent, @Delta and @FormatNumber for computed labels; do not invent arithmetic results.",
    "The host renders this library with HeroUI v3. Write the registered OpenUI component signatures, never JSX or imports.",
    "Bind interactive filters and mutation form inputs to $variables using the optional value prop. Use @Set and @Reset for local changes instead of asking the assistant again.",
    "Input's value is its fifth argument, Select's value is its fifth argument, TextArea's value is its fifth argument. Tabs value is its third argument.",
    "Use relation_metrics filters with $variables for live filtering; use Query's refresh argument only when the user needs automatic refresh, at least 30 seconds.",
    "All 72 HeroUI native components and their compound parts are available through HeroUI(component, children, options, name, value, action). Prefer compact analysis signatures for common controls; use HeroUI for additional native components. Never use JSX or fabricate compound part names.",
    "For native HeroUI composition use native semantic variants (primary/secondary/tertiary/danger), give controls an aria-label, and assign each bound control a unique name. options only accepts JSON; event functions and custom rendering code are supplied by the host.",
    "Calendar.GridHeader, Calendar.GridBody, RangeCalendar equivalents, DateField.Input and TimeField.Input supply their own render functions; pass empty children. Toast is a button that triggers a notification only on press.",
  ],
  examples: [
    `Example — Analysis table with follow-ups:
root = Card([header, table, next])
header = CardHeader("Revenue by region", "Verified query results")
table = Table([Col("Region", "string"), Col("Revenue", "number")], [["AMER", 440000], ["EMEA", 320000]])
next = FollowUpBlock([FollowUpItem("Explain the regional difference")])`,
    `Example — EvilCharts monthly trend:
root = Card([header, chart])
header = CardHeader("Monthly registrations", "Verified results")
chart = LineChart(["2026-09", "2026-10"], [Series("Users", [148, 43])], "Month", "Users")`,
    `Example — EvilCharts Sankey flow:
root = Card([header, chart])
header = CardHeader("Campaign flow", "Verified traffic by stage")
chart = SankeyChart([FlowNode("曝光"), FlowNode("点击"), FlowNode("转化")], [FlowLink("曝光", "点击", 420), FlowLink("点击", "转化", 86)])`,
    `Example — Native HeroUI number field bound to a live query variable:
root = Card([header, limit])
header = CardHeader("Result limit", "Choose the maximum number of groups")
$limit = 20
limit = HeroUI("NumberField", [label, group], { "aria-label": "Result limit", minValue: 1, maxValue: 1000 }, "resultLimit", $limit)
label = HeroUI("Label", ["Result limit"])
group = HeroUI("NumberField.Group", [less, input, more])
less = HeroUI("NumberField.DecrementButton", [])
input = HeroUI("NumberField.Input", [])
more = HeroUI("NumberField.IncrementButton", [])`,
    `Example — Interactive status filter:
root = Card([header, filter, tbl, reset])
header = CardHeader("Orders by status", "Change the status to refresh the database aggregate")
$status = "paid"
filter = FormControl("Status", Select("status", [SelectItem("paid", "Paid"), SelectItem("pending", "Pending")], null, null, $status))
data = Query("relation_metrics", { schema: "public", table: "orders", groupBy: ["status"], metrics: [{ fn: "count", alias: "count" }], filters: [{ column: "status", operator: "equals", value: $status }] }, { columns: [], rows: [] })
tbl = Table([Col("Status", "string"), Col("Orders", "number")], @Each(data.rows, "row", [row.status, row.count]))
reset = Buttons([Button("Reset filter", @Reset($status), "outline")])`,
  ],
};

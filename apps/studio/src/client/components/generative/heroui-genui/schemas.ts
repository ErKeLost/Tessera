import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { actionSchema } from "../shadcn-genui/action";
import { rulesSchema } from "../shadcn-genui/rules";

/** Stable OpenUI signatures, independent of any previous rendering library. */
function schema<T extends z.ZodObject>(name: string, props: T, description: string) {
  return defineComponent({ name, props, description, component: () => null });
}
const variants = z.enum(["default", "destructive", "outline", "secondary", "ghost", "link"]).optional();
const children = z.array(z.any()).default([]);
const Button = schema("Button", z.object({ label: z.string(), action: actionSchema, variant: variants, size: z.enum(["default", "xs", "sm", "lg", "icon"]).optional() }), "Action button with semantic variant and optional size.");
const Buttons = schema("Buttons", z.object({ buttons: z.array(Button.ref), direction: z.enum(["row", "column"]).optional() }), "Group of action buttons.");
const FormControl = schema("FormControl", z.object({ label: z.string(), field: z.any() }), "Labeled form field with validation feedback.");
const SelectItem = schema("SelectItem", z.object({ value: z.string(), label: z.string() }), "Select option.");
const CheckBoxItem = schema("CheckBoxItem", SelectItem.props, "Checkbox option.");
const RadioItem = schema("RadioItem", SelectItem.props, "Radio option.");
const SwitchItem = schema("SwitchItem", SelectItem.props, "Switch option.");
const Col = schema("Col", z.object({ header: z.string(), type: z.enum(["string", "number", "boolean"]).optional() }), "Table column header and value type.");
const TabItem = schema("TabItem", z.object({ value: z.string(), trigger: z.string(), content: children }), "Tab panel with a stable id, label and child nodes.");
const AccordionItem = schema("AccordionItem", z.object({ value: z.string(), trigger: z.string(), content: children }), "Accordion section with a stable id, heading and child nodes.");
const FollowUpItem = schema("FollowUpItem", z.object({ text: z.string() }), "Follow-up request sent as the next user message.");
const overlayProps = z.object({ triggerLabel: z.string(), title: z.string(), description: z.string().optional(), content: children });

export const heroSchemas = {
  Button, Buttons, FormControl, SelectItem, CheckBoxItem, RadioItem, SwitchItem, Col, TabItem, AccordionItem, FollowUpItem,
  Card: schema("Card", z.object({ children }), "Vertical answer container."),
  CardHeader: schema("CardHeader", z.object({ title: z.string(), description: z.string().optional() }), "Answer title and description."),
  Alert: schema("Alert", z.object({ title: z.string(), description: z.string(), variant: z.enum(["default", "destructive", "info", "success", "warning"]).optional() }), "Status banner with title and description."),
  Badge: schema("Badge", z.object({ text: z.string(), variant: variants }), "Compact status label."),
  Tag: schema("Tag", z.object({ text: z.string(), variant: variants }), "Compact tag."),
  TagBlock: schema("TagBlock", z.object({ tags: z.array(z.any()) }), "Group of strings or Tag nodes."),
  Avatar: schema("Avatar", z.object({ src: z.string().optional(), alt: z.string().optional(), fallback: z.string() }), "Avatar with fallback initials."),
  Progress: schema("Progress", z.object({ value: z.number(), label: z.string().optional() }), "Progress percentage from 0 to 100."),
  Separator: schema("Separator", z.object({ orientation: z.enum(["horizontal", "vertical"]).optional() }), "Content separator."),
  Label: schema("Label", z.object({ text: z.string(), htmlFor: z.string().optional() }), "Form field label."),
  Table: schema("Table", z.object({ columns: z.array(Col.ref), rows: z.array(z.array(z.any())) }), "Analysis table: column definitions followed by rows of values."),
  Tabs: schema("Tabs", z.object({ items: z.array(TabItem.ref), defaultValue: z.string().optional() }), "Tabbed analysis views."),
  Accordion: schema("Accordion", z.object({ items: z.array(AccordionItem.ref), type: z.enum(["single", "multiple"]).optional() }), "Expandable analysis sections."),
  FollowUpBlock: schema("FollowUpBlock", z.object({ items: z.array(FollowUpItem.ref) }), "Follow-up requests at the end of an answer."),
  SpinnerBlock: schema("SpinnerBlock", z.object({ label: z.string().optional() }), "Loading indicator."),
  SkeletonBlock: schema("SkeletonBlock", z.object({ lines: z.number().optional() }), "Loading placeholder lines."),
  Input: schema("Input", z.object({ name: z.string(), placeholder: z.string().optional(), type: z.enum(["text", "email", "password", "number", "url"]).optional(), rules: rulesSchema }), "Text field with optional validation rules."),
  TextArea: schema("TextArea", z.object({ name: z.string(), placeholder: z.string().optional(), rows: z.number().optional(), rules: rulesSchema }), "Multiline text field."),
  Select: schema("Select", z.object({ name: z.string(), items: z.array(SelectItem.ref), placeholder: z.string().optional(), rules: rulesSchema }), "Dropdown selection field."),
  CheckBoxGroup: schema("CheckBoxGroup", z.object({ name: z.string(), items: z.array(CheckBoxItem.ref) }), "Multiple selection field."),
  RadioGroup: schema("RadioGroup", z.object({ name: z.string(), items: z.array(RadioItem.ref) }), "Single selection field."),
  SwitchGroup: schema("SwitchGroup", z.object({ name: z.string(), items: z.array(SwitchItem.ref) }), "Boolean selection group."),
  Slider: schema("Slider", z.object({ name: z.string(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), defaultValue: z.number().optional() }), "Numeric slider."),
  DialogBlock: schema("DialogBlock", overlayProps.extend({ triggerVariant: variants }), "Button opening a modal detail view."),
  DrawerBlock: schema("DrawerBlock", overlayProps, "Button opening a bottom detail drawer."),
  PopoverBlock: schema("PopoverBlock", z.object({ trigger: z.string(), title: z.string().optional(), body: z.string() }), "Optional information in a floating panel."),
  TooltipBlock: schema("TooltipBlock", z.object({ text: z.string(), hint: z.string() }), "Term with a tooltip explanation."),
  PaginationBlock: schema("PaginationBlock", z.object({ currentPage: z.number(), totalPages: z.number() }), "Local page navigation."),
  DatePicker: schema("DatePicker", z.object({ name: z.string(), placeholder: z.string().optional() }), "Date selection field."),
  Form: schema("Form", z.object({ name: z.string(), buttons: Buttons.ref, fields: z.array(FormControl.ref).default([]) }), "Form with named fields and explicit action buttons."),
};

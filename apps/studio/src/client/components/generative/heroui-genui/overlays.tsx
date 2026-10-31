"use client";

import { Button, Calendar, DateField, DatePicker, Drawer, Modal, Pagination, Popover, Tooltip } from "@heroui/react";
import { parseDate } from "@internationalized/date";
import { defineComponent, reactive, useIsStreaming, useStateField } from "@openuidev/react-lang";
import { z } from "zod";
import { heroSchemas } from "./schemas";
import { buttonVariant } from "./controls";

const base = heroSchemas;
export const HeroDialog = defineComponent({
  ...base.DialogBlock!,
  component: ({ props, renderNode }) => <Modal>
    <Button isDisabled={useIsStreaming()} variant={buttonVariant(props.triggerVariant ?? "outline")}>{props.triggerLabel}</Button>
    <Modal.Backdrop className="tessera-heroui"><Modal.Container><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><Modal.Heading>{props.title}</Modal.Heading>{props.description ? <p>{props.description}</p> : null}</Modal.Header><Modal.Body className="space-y-3">{renderNode(props.content)}</Modal.Body></Modal.Dialog></Modal.Container></Modal.Backdrop>
  </Modal>,
});
export const HeroDrawer = defineComponent({
  ...base.DrawerBlock!,
  component: ({ props, renderNode }) => <Drawer>
    <Button isDisabled={useIsStreaming()} variant="outline">{props.triggerLabel}</Button>
    <Drawer.Backdrop className="tessera-heroui"><Drawer.Content placement="bottom"><Drawer.Dialog><Drawer.CloseTrigger /><Drawer.Header><Drawer.Heading>{props.title}</Drawer.Heading>{props.description ? <p>{props.description}</p> : null}</Drawer.Header><Drawer.Body className="space-y-3">{renderNode(props.content)}</Drawer.Body><Drawer.Footer><Button slot="close" variant="secondary">Close</Button></Drawer.Footer></Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
  </Drawer>,
});
export const HeroPopover = defineComponent({
  ...base.PopoverBlock!,
  component: ({ props }) => <Popover><Button variant="outline" isDisabled={useIsStreaming()}>{props.trigger}</Button><Popover.Content className="tessera-heroui"><Popover.Dialog>{props.title ? <Popover.Heading>{props.title}</Popover.Heading> : null}<p>{props.body}</p></Popover.Dialog></Popover.Content></Popover>,
});
export const HeroTooltip = defineComponent({
  ...base.TooltipBlock!,
  component: ({ props }) => <Tooltip><Button variant="ghost" size="sm">{props.text}</Button><Tooltip.Content className="tessera-heroui">{props.hint}</Tooltip.Content></Tooltip>,
});
export const HeroPagination = defineComponent({
  ...base.PaginationBlock!,
  props: base.PaginationBlock!.props.extend({ value: reactive(z.number().optional()) }),
  description: "Local page navigation. Optional third value argument binds a $page variable, so changing page refreshes dependent Query calls without another model turn.",
  component: ({ props }) => {
    const field = useStateField("page", props.value);
    const disabled = useIsStreaming();
    const total = Math.max(1, Math.floor(Number(props.totalPages) || 1));
    const current = Math.max(1, Math.min(total, Math.floor(Number(field.value ?? props.currentPage) || 1)));
    const pages = [...new Set([1, Math.max(1, current - 1), current, Math.min(total, current + 1), total])].sort((a, b) => a - b);
    return <Pagination><Pagination.Summary>Page {current} of {total}</Pagination.Summary><Pagination.Content>
      <Pagination.Item><Pagination.Previous isDisabled={disabled || current === 1} onPress={() => field.setValue(current - 1)}>Previous</Pagination.Previous></Pagination.Item>
      {pages.map((page) => <Pagination.Item key={page}><Pagination.Link isDisabled={disabled} isActive={page === current} onPress={() => field.setValue(page)}>{page}</Pagination.Link></Pagination.Item>)}
      <Pagination.Item><Pagination.Next isDisabled={disabled || current === total} onPress={() => field.setValue(current + 1)}>Next</Pagination.Next></Pagination.Item>
    </Pagination.Content></Pagination>;
  },
});

export const HeroDatePicker = defineComponent({
  ...base.DatePicker!,
  props: base.DatePicker!.props.extend({ value: reactive(z.string().optional()) }),
  description: "Date input with a HeroUI calendar. Third value argument binds an ISO date string $variable (YYYY-MM-DD).",
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    let date = null;
    try { if (typeof field.value === "string" && field.value) date = parseDate(field.value.slice(0, 10)); } catch { /* An incomplete generated date renders empty. */ }
    return <DatePicker aria-label={props.placeholder ?? props.name} name={props.name} isDisabled={useIsStreaming()} value={date} onChange={(value) => field.setValue(value?.toString() ?? "")}>
      <DateField.Group fullWidth><DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input><DateField.Suffix><DatePicker.Trigger><DatePicker.TriggerIndicator /></DatePicker.Trigger></DateField.Suffix></DateField.Group>
      <DatePicker.Popover className="tessera-heroui"><Calendar aria-label="Choose date"><Calendar.Header><Calendar.Heading /><Calendar.NavButton slot="previous" /><Calendar.NavButton slot="next" /></Calendar.Header><Calendar.Grid><Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader><Calendar.GridBody>{(value) => <Calendar.Cell date={value} />}</Calendar.GridBody></Calendar.Grid></Calendar></DatePicker.Popover>
    </DatePicker>;
  },
});

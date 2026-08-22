import {
  eventPortSchema,
  type EventPort,
  type JsonValue,
} from "@open-generative/protocol";
import type { NodeScopedEventEmitter } from "@open-generative/react";

type EventCapableRendererInput =
  | Readonly<{
      projectionMode: "committed";
      emit?: NodeScopedEventEmitter;
      node: Readonly<{ events: Readonly<Record<string, unknown>> }>;
    }>
  | Readonly<{
      projectionMode: "read-only-preview";
      emit?: never;
      node: Readonly<{ events: Readonly<Record<string, unknown>> }>;
    }>;

export type OfficialRendererEventPortMap = Readonly<{
  apply: EventPort;
  change: EventPort;
  copy: EventPort;
  dismiss: EventPort;
  export: EventPort;
  legendToggle: EventPort;
  pageChange: EventPort;
  rangeChange: EventPort;
  reset: EventPort;
  retry: EventPort;
  rowSelect: EventPort;
  select: EventPort;
  sortChange: EventPort;
}>;

export const officialRendererEventPorts: OfficialRendererEventPortMap = Object.freeze({
  apply: eventPortSchema.parse("apply"),
  change: eventPortSchema.parse("change"),
  copy: eventPortSchema.parse("copy"),
  dismiss: eventPortSchema.parse("dismiss"),
  export: eventPortSchema.parse("export"),
  legendToggle: eventPortSchema.parse("legendToggle"),
  pageChange: eventPortSchema.parse("pageChange"),
  rangeChange: eventPortSchema.parse("rangeChange"),
  reset: eventPortSchema.parse("reset"),
  retry: eventPortSchema.parse("retry"),
  rowSelect: eventPortSchema.parse("rowSelect"),
  select: eventPortSchema.parse("select"),
  sortChange: eventPortSchema.parse("sortChange"),
});

export function canEmit(input: EventCapableRendererInput, port: EventPort): boolean {
  return input.projectionMode === "committed"
    && input.emit !== undefined
    && input.node.events[port] !== undefined;
}

export function emitEvent(
  input: EventCapableRendererInput,
  port: EventPort,
  payload: JsonValue,
): void {
  if (!canEmit(input, port) || input.emit === undefined) return;
  void input.emit(port, payload);
}

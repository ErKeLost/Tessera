import type { NodeId, StateId } from "./ids";

declare const nodeId: NodeId;
declare const stateId: StateId;

const acceptsNodeId = (_value: NodeId): void => {};
acceptsNodeId(nodeId);
// @ts-expect-error State and node IDs are not interchangeable.
acceptsNodeId(stateId);

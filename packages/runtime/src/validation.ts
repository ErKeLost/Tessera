import type {
  CanonicalNode,
  ContractRef,
  DocumentContent,
  NodeId,
} from "@open-generative/protocol";
import type { MaybePromise } from "./utils";

export type RuntimeValidationIssue = {
  code: string;
  message: string;
  nodeId?: NodeId;
};

export interface RuntimeValidationPort {
  validateNode(input: {
    nodeId: NodeId;
    node: CanonicalNode;
    document: DocumentContent;
    phase: "preview" | "commit";
    signal?: AbortSignal;
  }): MaybePromise<readonly RuntimeValidationIssue[]>;
  validateDocument(input: {
    document: DocumentContent;
    phase: "commit";
    signal?: AbortSignal;
  }): MaybePromise<readonly RuntimeValidationIssue[]>;
  commitPolicy(contract: ContractRef, options?: { signal?: AbortSignal }): MaybePromise<"progressive" | "atomic">;
  isNodeReady(input: {
    nodeId: NodeId;
    node: CanonicalNode;
    document: DocumentContent;
    signal?: AbortSignal;
  }): MaybePromise<boolean>;
}

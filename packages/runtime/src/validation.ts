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
  }): MaybePromise<readonly RuntimeValidationIssue[]>;
  validateDocument(input: {
    document: DocumentContent;
    phase: "commit";
  }): MaybePromise<readonly RuntimeValidationIssue[]>;
  commitPolicy(contract: ContractRef): MaybePromise<"progressive" | "atomic">;
  isNodeReady(input: {
    nodeId: NodeId;
    node: CanonicalNode;
    document: DocumentContent;
  }): MaybePromise<boolean>;
}

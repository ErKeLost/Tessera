import { useOutletContext } from "react-router";
import type { StudioThreadSummary } from "../api/studio-api";
import type {
  useRefreshStudioWorkspace,
  useStudioWorkspaceQueries,
} from "../queries/studio-queries";

/** Transient page hint for the chat transport; it contains no data values. */
export type StudioAgentPageContext = Readonly<{
  currentRelation?: Readonly<{
    catalogFingerprint: string;
    schema: string;
    table: string;
  }>;
  hasLocalFilter: boolean;
  view: "data" | "definition";
}>;

export type StudioRouteContext = Readonly<{
  activeThread: StudioThreadSummary | undefined;
  activeThreadId: string | undefined;
  agentPageContext: StudioAgentPageContext | undefined;
  refreshWorkspace: ReturnType<typeof useRefreshStudioWorkspace>;
  workspace: ReturnType<typeof useStudioWorkspaceQueries>;
}>;

export function useStudioRouteContext() {
  return useOutletContext<StudioRouteContext>();
}

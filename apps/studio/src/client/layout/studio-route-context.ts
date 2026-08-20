import { useOutletContext } from "react-router";
import type { StudioThreadSummary } from "../api/studio-api";
import type { StudioSettingsTab } from "../studio-settings";
import type {
  useRefreshStudioWorkspace,
  useStudioWorkspaceQueries,
} from "../queries/studio-queries";

/** Transient table-selection hint sent with a chat turn; it contains no row values. */
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
  openSettings(tab: StudioSettingsTab): void;
  refreshWorkspace: ReturnType<typeof useRefreshStudioWorkspace>;
  workspace: ReturnType<typeof useStudioWorkspaceQueries>;
}>;

export function useStudioRouteContext() {
  return useOutletContext<StudioRouteContext>();
}

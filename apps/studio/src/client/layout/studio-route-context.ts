import { useOutletContext } from "react-router";
import type { StudioThreadSummary } from "../api/studio-api";
import type { StudioSettingsTab } from "../studio-settings";
import type {
  useRefreshStudioWorkspace,
  useStudioWorkspaceQueries,
} from "../queries/studio-queries";

export type StudioRouteContext = Readonly<{
  activeThread: StudioThreadSummary | undefined;
  activeThreadId: string | undefined;
  openSettings(tab: StudioSettingsTab): void;
  refreshWorkspace: ReturnType<typeof useRefreshStudioWorkspace>;
  workspace: ReturnType<typeof useStudioWorkspaceQueries>;
}>;

export function useStudioRouteContext() {
  return useOutletContext<StudioRouteContext>();
}

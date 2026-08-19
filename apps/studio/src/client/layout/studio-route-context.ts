import { useOutletContext } from "react-router";
import type { StudioThreadSummary } from "../api/studio-api";
import type {
  useRefreshStudioWorkspace,
  useStudioWorkspaceQueries,
} from "../queries/studio-queries";

export type StudioRouteContext = Readonly<{
  activeThread: StudioThreadSummary | undefined;
  activeThreadId: string | undefined;
  refreshWorkspace: ReturnType<typeof useRefreshStudioWorkspace>;
  workspace: ReturnType<typeof useStudioWorkspaceQueries>;
}>;

export function useStudioRouteContext() {
  return useOutletContext<StudioRouteContext>();
}

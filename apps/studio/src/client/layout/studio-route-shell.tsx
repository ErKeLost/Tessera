import {
  ChevronDownIcon,
  HistoryIcon,
  PlusIcon,
  Settings2Icon,
  Table2Icon,
} from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { publicError } from "../api/studio-api";
import { Button } from "../components/motion/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  useRefreshStudioWorkspace,
  useStudioThreadMutations,
  useStudioThreadsQuery,
  useStudioWorkspaceQueries,
} from "../queries/studio-queries";
import { StudioHistoryMenu } from "../studio-history-menu";
import { StudioSettingsDialog, type StudioSettingsTab } from "../studio-settings";
import { StudioThemePicker } from "../studio-theme";
import { TooltipIconButton } from "../components/assistant-ui/tooltip-icon-button";
import { StudioDatabasePanel } from "../components/database/studio-database-panel";
import type { StudioRouteContext } from "./studio-route-context";

export function StudioRouteShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: threads = [], isLoading: threadsLoading, error: threadsError } = useStudioThreadsQuery();
  const mutations = useStudioThreadMutations();
  const workspace = useStudioWorkspaceQueries();
  const refreshWorkspace = useRefreshStudioWorkspace();
  const threadId = location.pathname.match(/^\/chat\/([^/]+)/)?.[1];
  const activeThreadId = threadId ? decodeURIComponent(threadId) : undefined;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<StudioSettingsTab>("database");
  const databasePanelRef = useRef<PanelImperativeHandle | null>(null);
  const databasePanelInitialized = useRef(false);

  useLayoutEffect(() => {
    const panel = databasePanelRef.current;
    if (!panel) return;
    if (!databasePanelInitialized.current) {
      databasePanelInitialized.current = true;
      if (!databaseOpen) panel.collapse();
      return;
    }
    if (databaseOpen) panel.expand();
    else panel.collapse();
  }, [databaseOpen]);

  const openSettings = useCallback((tab: StudioSettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const createThread = useCallback(async () => {
    try {
      const created = await mutations.create.mutateAsync();
      navigate(`/chat/${encodeURIComponent(created.id)}`);
    } catch {
      // The sidebar keeps its inline error surface for failed commands.
    }
  }, [mutations.create, navigate]);

  const renameThread = useCallback(async (id: string, title: string) => {
    await mutations.rename.mutateAsync({ threadId: id, title });
  }, [mutations.rename]);

  const deleteThread = useCallback(async (id: string) => {
    await mutations.remove.mutateAsync(id);
    if (id !== activeThreadId) return;
    const next = threads.find((thread) => thread.id !== id);
    navigate(next ? `/chat/${encodeURIComponent(next.id)}` : "/");
  }, [activeThreadId, mutations.remove, navigate, threads]);

  const onSelectThread = useCallback((id: string) => {
    navigate(`/chat/${encodeURIComponent(id)}`);
  }, [navigate]);

  const routeContext: StudioRouteContext = {
    activeThread,
    activeThreadId,
    openSettings,
    refreshWorkspace,
    workspace,
  };

  return (
    <div className="studio-minimal-shell">
      <header className="studio-minimal-header">
        <nav aria-label="Workspace tools" className="studio-minimal-actions">
          <Popover onOpenChange={setHistoryOpen} open={historyOpen}>
            <PopoverTrigger asChild>
              <Button className="studio-history-trigger" size="sm" type="button" variant="ghost">
                <HistoryIcon aria-hidden="true" size={15} />
                <span>History</span>
                <ChevronDownIcon aria-hidden="true" size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="studio-history-popover" sideOffset={8}>
              <StudioHistoryMenu
                activeThreadId={activeThreadId}
                error={threadsError ? publicError(threadsError) : undefined}
                isCreating={mutations.create.isPending}
                isLoading={threadsLoading}
                onClose={() => setHistoryOpen(false)}
                onCreate={createThread}
                onDelete={deleteThread}
                onRename={renameThread}
                onSelect={onSelectThread}
                threads={threads}
              />
            </PopoverContent>
          </Popover>
          <Button aria-label="Start a new analysis" className="studio-new-thread-button" onClick={() => void createThread()} size="sm" type="button" variant="secondary">
            <PlusIcon aria-hidden="true" size={16} />
            <span>New</span>
          </Button>
          <TooltipIconButton
            aria-label="Open database explorer"
            className="studio-header-tool studio-database-button"
            onClick={() => setDatabaseOpen((open) => !open)}
            tooltip={databaseOpen ? "Close database explorer" : "Open database explorer"}
            type="button"
          >
            <Table2Icon aria-hidden="true" size={16} />
          </TooltipIconButton>
          <TooltipIconButton
            aria-label="Configure workspace"
            className="studio-header-tool studio-settings-button"
            onClick={() => openSettings("database")}
            tooltip="Configure workspace"
            type="button"
          >
            <Settings2Icon aria-hidden="true" size={16} />
          </TooltipIconButton>
          <StudioThemePicker />
        </nav>
      </header>
      <div className="studio-minimal-route">
        <Group
          className="studio-workspace-panels"
          data-database-open={databaseOpen || undefined}
          id="studio-workspace-panels"
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
        >
          <Panel className="studio-ai-panel" id="studio-chat-panel" minSize="280px">
            <Outlet context={routeContext} />
          </Panel>
          <Separator
            aria-label="Resize database explorer"
            className="studio-database-resize-handle"
            disabled={!databaseOpen}
            id="studio-database-resize-handle"
          />
          <Panel
            className="studio-database-panel-host"
            collapsedSize="0px"
            collapsible
            defaultSize="42%"
            id="studio-database-panel"
            maxSize="68%"
            minSize="25%"
            onResize={(size) => {
              const nextOpen = size.inPixels > 48;
              setDatabaseOpen((current) => current === nextOpen ? current : nextOpen);
            }}
            panelRef={databasePanelRef}
          >
            <StudioDatabasePanel
              catalog={workspace.catalog.data}
              catalogError={workspace.catalog.error ? publicError(workspace.catalog.error) : undefined}
              connection={workspace.connection.data}
              connectionError={workspace.connection.error ? publicError(workspace.connection.error) : undefined}
              onClose={() => setDatabaseOpen(false)}
              onRefresh={() => { void refreshWorkspace(); }}
              open={databaseOpen}
              refreshing={workspace.catalog.isFetching}
            />
          </Panel>
        </Group>
      </div>
      <StudioSettingsDialog
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
        onSaved={() => { void refreshWorkspace(); }}
        open={settingsOpen}
      />
    </div>
  );
}

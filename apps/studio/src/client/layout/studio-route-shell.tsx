import {
  GripVerticalIcon,
} from "lucide-react";
import { GooeyToaster } from "goey-toast";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { publicError } from "../api/studio-api";
import { isFeishuEnvironment } from "../feishu-environment";
import { FeishuAuthorizationDialog } from "../feishu-authorization-dialog";
import { Button } from "../components/motion/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  useRefreshStudioWorkspace,
  useStudioSettingsQuery,
  useStudioThreadMutations,
  useStudioThreadsQuery,
  useStudioWorkspaceQueries,
  useStudioFeishuQuery,
} from "../queries/studio-queries";
import { StudioHistoryMenu } from "../studio-history-menu";
import { StudioSettingsDialog, type StudioSettingsTab } from "../studio-settings";
import { StudioThemePicker, useStudioTheme } from "../studio-theme";
import { StudioIcon } from "../components/studio-icon";
import { TooltipIconButton } from "../components/assistant-ui/tooltip-icon-button";
import { RouteLoading } from "../routes/route-state";
import type { TableEditorAgentPageContext } from "../table-editor";
import type { StudioAgentPageContext, StudioRouteContext } from "./studio-route-context";

const TableEditor = lazy(() => import("../table-editor").then(({ TableEditor: Editor }) => ({ default: Editor })));

const DEFAULT_DATABASE_PANEL_SIZE = 70;
const MIN_DATABASE_PANEL_SIZE = "36%";
const MIN_ASSISTANT_PANEL_SIZE = "24%";

export function StudioRouteShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isFeishu = isFeishuEnvironment({ pathname: location.pathname, userAgent: navigator.userAgent, referrer: document.referrer });
  const agentType = isFeishu ? "feishu" : "database";
  const chatPath = useCallback((id: string) => `${isFeishu ? "/feishu" : ""}/chat/${encodeURIComponent(id)}`, [isFeishu]);
  const { data: allThreads = [], isLoading: threadsLoading, error: threadsError } = useStudioThreadsQuery();
  const threads = allThreads.filter((thread) => thread.agentType === agentType);
  const mutations = useStudioThreadMutations();
  const workspace = useStudioWorkspaceQueries(!isFeishu);
  const feishuStatus = useStudioFeishuQuery(isFeishu);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const prompted = useRef(false);
  const refreshWorkspace = useRefreshStudioWorkspace();
  const settingsQuery = useStudioSettingsQuery();
  const { resolvedTheme } = useStudioTheme();
  const threadId = location.pathname.match(/^(?:\/feishu)?\/chat\/([^/]+)/)?.[1];
  const activeThreadId = threadId ? decodeURIComponent(threadId) : undefined;
  const activeThread = allThreads.find((thread) => thread.id === activeThreadId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [agentPageContext, setAgentPageContext] = useState<StudioAgentPageContext>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<StudioSettingsTab>("database");
  const databasePanelRef = useRef<PanelImperativeHandle>(null);
  const databaseSize = useMotionValue(0);
  const lastDatabaseSizeRef = useRef(DEFAULT_DATABASE_PANEL_SIZE);
  const reduceMotion = useReducedMotion() ?? false;

  useMotionValueEvent(databaseSize, "change", (size) => {
    databasePanelRef.current?.resize(`${size}%`);
  });

  useEffect(() => {
    const targetSize = databaseOpen ? lastDatabaseSizeRef.current : 0;
    const controls = animate(databaseSize, targetSize, {
      duration: reduceMotion ? 0 : 0.38,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [databaseOpen, databaseSize, reduceMotion]);

  useEffect(() => {
    if (!databaseOpen) setAgentPageContext(undefined);
  }, [databaseOpen]);

  const openSettings = useCallback((tab: StudioSettingsTab) => {
    setSettingsTab(isFeishu && (tab === "database" || tab === "permissions") ? "model" : tab);
    setSettingsOpen(true);
  }, [isFeishu]);
  useEffect(() => {
    if (isFeishu && feishuStatus.data && !feishuStatus.data.connected && !prompted.current) {
      prompted.current = true;
      setFeishuOpen(true);
    }
  }, [isFeishu, feishuStatus.data]);

  const onAgentPageContextChange = useCallback((context: TableEditorAgentPageContext | undefined) => {
    if (!context) {
      setAgentPageContext(undefined);
      return;
    }
    setAgentPageContext({
      hasLocalFilter: context.filterActive,
      view: context.view,
      ...(context.schema && context.table ? {
        currentRelation: {
          catalogFingerprint: context.catalogFingerprint,
          schema: context.schema,
          table: context.table,
        },
      } : {}),
    });
  }, []);

  const createThread = useCallback(async () => {
    try {
      const created = await mutations.create.mutateAsync(agentType);
      navigate(chatPath(created.id));
    } catch {
      // The sidebar keeps its inline error surface for failed commands.
    }
  }, [agentType, chatPath, mutations.create, navigate]);

  const renameThread = useCallback(async (id: string, title: string) => {
    await mutations.rename.mutateAsync({ threadId: id, title });
  }, [mutations.rename]);

  const deleteThread = useCallback(async (id: string) => {
    await mutations.remove.mutateAsync(id);
    if (id !== activeThreadId) return;
    const next = threads.find((thread) => thread.id !== id);
    navigate(next ? chatPath(next.id) : isFeishu ? "/feishu" : "/");
  }, [activeThreadId, chatPath, isFeishu, mutations.remove, navigate, threads]);

  const clearThreads = useCallback(async () => {
    await Promise.all(threads.map((thread) => mutations.remove.mutateAsync(thread.id)));
    navigate(isFeishu ? "/feishu" : "/");
    setHistoryOpen(false);
  }, [isFeishu, mutations.remove, navigate, threads]);

  const onSelectThread = useCallback((id: string) => {
    navigate(chatPath(id));
  }, [chatPath, navigate]);

  const routeContext: StudioRouteContext = {
    activeThread,
    activeThreadId,
    threadsLoading,
    agentType,
    isFeishu,
    chatPath,
    openFeishuAuthorization: () => setFeishuOpen(true),
    agentPageContext,
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
                <StudioIcon icon="solar:history-linear" size={16} />
                <span>History</span>
                <StudioIcon icon="solar:alt-arrow-down-linear" size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="studio-history-popover" sideOffset={8}>
              <StudioHistoryMenu
                activeThreadId={activeThreadId}
                error={mutations.clear.error || threadsError ? publicError(mutations.clear.error ?? threadsError) : undefined}
                isClearing={mutations.clear.isPending}
                isCreating={mutations.create.isPending}
                isLoading={threadsLoading}
                onClear={clearThreads}
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
            <StudioIcon icon="solar:add-circle-linear" size={16} />
            <span>New</span>
          </Button>
          {!isFeishu ? <TooltipIconButton
            aria-label="Open database explorer"
            className="studio-header-tool studio-database-button"
            onClick={() => setDatabaseOpen((open) => !open)}
            tooltip={databaseOpen ? "Close database explorer" : "Open database explorer"}
            type="button"
          >
            <StudioIcon icon="solar:database-linear" size={17} />
          </TooltipIconButton> : <Button type="button" size="sm" variant="outline" onClick={() => setFeishuOpen(true)}>{feishuStatus.data?.connected ? "飞书已连接" : "连接飞书"}</Button>}
          <TooltipIconButton
            aria-label="Configure workspace"
            className="studio-header-tool studio-settings-button"
            onClick={() => openSettings("database")}
            tooltip="Configure workspace"
            type="button"
          >
            <StudioIcon icon="solar:settings-linear" size={17} />
          </TooltipIconButton>
          <StudioThemePicker />
        </nav>
      </header>
      <div className="studio-minimal-route">
        <Group
          className="studio-database-workbench"
          data-database-open={databaseOpen || undefined}
          id="studio-database-workbench"
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
        >
          <Panel
            className="studio-database-panel"
            collapsedSize="0%"
            collapsible
            defaultSize="0%"
            id="studio-database-panel"
            minSize={MIN_DATABASE_PANEL_SIZE}
            onResize={(size) => {
              if (databaseOpen && size.asPercentage >= 36) lastDatabaseSizeRef.current = size.asPercentage;
            }}
            panelRef={databasePanelRef}
          >
            <AnimatePresence initial={false}>
              {databaseOpen && !isFeishu ? (
                <motion.div
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, filter: "blur(0px)" }}
                  className="studio-database-panel-content"
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -18, filter: "blur(2px)" }}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -18, filter: "blur(2px)" }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Suspense fallback={<RouteLoading label="Loading data explorer" />}>
                    <TableEditor
                      catalog={workspace.catalog.data}
                      catalogError={workspace.catalog.error ? publicError(workspace.catalog.error) : undefined}
                      connection={workspace.connection.data}
                      connectionError={workspace.connection.error ? publicError(workspace.connection.error) : undefined}
                      onAgentPageContextChange={onAgentPageContextChange}
                      onClose={() => setDatabaseOpen(false)}
                      onRefreshCatalog={refreshWorkspace}
                      refreshingCatalog={workspace.catalog.isFetching}
                    />
                  </Suspense>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </Panel>
          <Separator
            aria-label="Resize database explorer"
            className="studio-workspace-resize-handle"
            disabled={!databaseOpen}
          >
            <span aria-hidden="true" className="studio-workspace-resize-grip">
              <GripVerticalIcon size={12} strokeWidth={1.8} />
            </span>
          </Separator>
          <Panel
            className="studio-assistant-panel"
            defaultSize="100%"
            id="studio-chat-panel"
            minSize={MIN_ASSISTANT_PANEL_SIZE}
          >
            <div className="studio-ai-panel">
              <Outlet context={routeContext} />
            </div>
          </Panel>
        </Group>
      </div>
      <StudioSettingsDialog
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
        onSaved={() => {
          if (!isFeishu) void refreshWorkspace();
          void settingsQuery.refetch();
        }}
        agentType={agentType}
        open={settingsOpen}
      />
      {isFeishu ? <FeishuAuthorizationDialog open={feishuOpen} onOpenChange={setFeishuOpen} /> : null}
      <GooeyToaster
        closeOnEscape
        offset="24px"
        position="bottom-right"
        preset="snappy"
        showTimestamp={false}
        theme={resolvedTheme}
      />
    </div>
  );
}

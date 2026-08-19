import {
  ChevronDownIcon,
  HistoryIcon,
  PlusIcon,
  Table2Icon,
} from "lucide-react";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
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
import { StudioThemePicker } from "../studio-theme";
import { RouteLoading } from "../routes/route-state";
import { StudioDock } from "./studio-dock";
import type { StudioRouteContext } from "./studio-route-context";

const TableEditor = lazy(() => import("../table-editor").then(({ TableEditor: Editor }) => ({ default: Editor })));

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
  const databasePanelRef = useRef<PanelImperativeHandle>(null);
  const databaseSize = useMotionValue(0);
  const lastDatabaseSizeRef = useRef(68);
  const reduceMotion = useReducedMotion() ?? false;
  const isChatRoute = location.pathname.startsWith("/chat/");

  useMotionValueEvent(databaseSize, "change", (size) => {
    databasePanelRef.current?.resize(`${size}%`);
  });

  useEffect(() => {
    if (!isChatRoute) return;
    const targetSize = databaseOpen ? lastDatabaseSizeRef.current : 0;
    const controls = animate(databaseSize, targetSize, {
      duration: reduceMotion ? 0 : 0.38,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [databaseOpen, databaseSize, isChatRoute, reduceMotion]);

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
    refreshWorkspace,
    workspace,
  };

  const toggleDatabase = () => {
    if (!isChatRoute) {
      setDatabaseOpen(true);
      navigate("/");
      return;
    }
    setDatabaseOpen((open) => !open);
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
          <button
            aria-label={databaseOpen ? "Close data explorer" : "Open data explorer"}
            aria-pressed={databaseOpen}
            className="studio-header-tool"
            onClick={toggleDatabase}
            title={databaseOpen ? "Close data explorer" : "Data explorer"}
            type="button"
          >
            <Table2Icon aria-hidden="true" size={16} />
          </button>
          <StudioThemePicker />
        </nav>
      </header>
      <div className="studio-minimal-route">
        {isChatRoute ? (
          <Group
            className="studio-database-workbench"
            data-database-open={databaseOpen || undefined}
            id="studio-database-workbench"
            orientation="horizontal"
          >
            <Panel
              collapsible
              collapsedSize="0%"
              defaultSize="0%"
              id="database"
              minSize="0%"
              onResize={(size) => {
                if (databaseOpen && size.asPercentage >= 44) lastDatabaseSizeRef.current = size.asPercentage;
              }}
              panelRef={databasePanelRef}
            >
              <AnimatePresence initial={false}>
                {databaseOpen ? (
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
                        onClose={() => setDatabaseOpen(false)}
                        onRefreshCatalog={() => void refreshWorkspace()}
                        refreshingCatalog={workspace.catalog.isFetching}
                      />
                    </Suspense>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </Panel>
            <Separator className="studio-workspace-resize-handle" id="database-ai-separator">
              <span aria-hidden="true" className="studio-workspace-resize-grip" />
            </Separator>
            <Panel defaultSize="100%" id="assistant" minSize="0%">
              <div className="studio-ai-panel">
                <Outlet context={routeContext} />
              </div>
            </Panel>
          </Group>
        ) : <Outlet context={routeContext} />}
      </div>
      {!location.pathname.startsWith("/chat/") && location.pathname !== "/" ? <StudioDock /> : null}
    </div>
  );
}

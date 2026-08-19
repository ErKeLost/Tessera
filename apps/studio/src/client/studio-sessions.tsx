import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { CircleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import { ThreadList } from "./components/assistant-ui/thread-list";
import { Alert, AlertDescription } from "./components/ui/alert";
import type { StudioThreadSummary } from "./api/studio-api";

export type { StudioThreadSummary } from "./api/studio-api";

const EMPTY_SESSION_MESSAGES: readonly ThreadMessage[] = [];

type StudioSessionListProps = {
  activeThreadId: string | undefined;
  error: string | undefined;
  isCreating: boolean;
  isLoading: boolean;
  onCreate(): Promise<void> | void;
  onDelete(threadId: string): Promise<void> | void;
  onRename(threadId: string, title: string): Promise<void> | void;
  onSelect(threadId: string): void;
  threads: readonly StudioThreadSummary[];
};

type StudioSessionSidebarProps = StudioSessionListProps & Readonly<{
  busyThreadId?: string;
}>;

/**
 * Keeps the workspace shell and the proven Assistant UI thread controls
 * separate. The sidebar only owns framing; selection, rename, and deletion
 * remain in StudioSessionList's existing runtime adapter.
 */
export function StudioSessionSidebar({ busyThreadId, isCreating, ...props }: StudioSessionSidebarProps) {
  return (
    <aside className="studio-session-sidebar">
      <header className="studio-session-sidebar-header">
        <div className="studio-session-product">
          <div aria-hidden="true" className="studio-session-product-mark">
            <img alt="" className="studio-session-logo" src="/tessera-logo.png" />
          </div>
          <span>Tessera</span>
        </div>
      </header>
      <StudioSessionList
        {...props}
        isCreating={isCreating || busyThreadId !== undefined}
      />
    </aside>
  );
}

/**
 * The beUI shell owns layout and motion. This adapter deliberately retains
 * Assistant UI's ThreadList so all persisted-session interactions stay on the
 * existing, proven control surface.
 */
export function StudioSessionList({
  activeThreadId,
  error,
  isCreating,
  isLoading,
  onCreate,
  onDelete,
  onRename,
  onSelect,
  threads,
}: StudioSessionListProps) {
  const threadList = useMemo(
    () => ({
      isLoading,
      threadId: activeThreadId,
      threads: threads.map((thread) => ({
        id: thread.id,
        remoteId: thread.id,
        status: "regular" as const,
        title: thread.title,
      })),
      onSwitchToNewThread: async () => {
        if (isCreating) return;
        await onCreate();
      },
      onSwitchToThread: (threadId: string) => onSelect(threadId),
      onRename: async (threadId: string, title: string) => {
        if (isCreating) return;
        await onRename(threadId, title);
      },
      onDelete: async (threadId: string) => {
        if (isCreating) return;
        await onDelete(threadId);
      },
    }),
    [activeThreadId, isCreating, isLoading, onCreate, onDelete, onRename, onSelect, threads],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    adapters: { threadList },
    messages: EMPTY_SESSION_MESSAGES,
    onNew: async () => {},
    setMessages: () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <nav aria-label="Saved analysis sessions" className="studio-session-list">
        <ThreadList onNew={onCreate} />
        {error ? (
          <Alert className="studio-session-error" role="status" variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </nav>
    </AssistantRuntimeProvider>
  );
}

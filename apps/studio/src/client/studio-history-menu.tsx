import {
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StudioThreadSummary } from "./api/studio-api";

type StudioHistoryMenuProps = Readonly<{
  activeThreadId: string | undefined;
  error: string | undefined;
  isCreating: boolean;
  isLoading: boolean;
  onClose(): void;
  onCreate(): Promise<void> | void;
  onDelete(threadId: string): Promise<void> | void;
  onRename(threadId: string, title: string): Promise<void> | void;
  onSelect(threadId: string): void;
  threads: readonly StudioThreadSummary[];
}>;

export function StudioHistoryMenu({
  activeThreadId,
  error,
  isCreating,
  isLoading,
  onClose,
  onCreate,
  onDelete,
  onRename,
  onSelect,
  threads,
}: StudioHistoryMenuProps) {
  const [menuThreadId, setMenuThreadId] = useState<string>();
  const [renamingThreadId, setRenamingThreadId] = useState<string>();
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, [renamingThreadId]);

  const beginRename = (thread: StudioThreadSummary) => {
    setMenuThreadId(undefined);
    setRenamingThreadId(thread.id);
    setDraftTitle(thread.title);
  };

  const finishRename = async (thread: StudioThreadSummary) => {
    const title = draftTitle.trim();
    setRenamingThreadId(undefined);
    if (!title || title === thread.title) return;
    await onRename(thread.id, title);
  };

  const removeThread = async (thread: StudioThreadSummary) => {
    setMenuThreadId(undefined);
    if (!window.confirm(`Delete "${thread.title}"? This cannot be undone.`)) return;
    await onDelete(thread.id);
  };

  return (
    <section aria-label="Session history" className="studio-history-menu">
      <div className="studio-history-items">
        {isLoading ? <HistoryLoading /> : null}
        {!isLoading && threads.length === 0 ? (
          <p className="studio-history-empty">No saved sessions yet.</p>
        ) : null}
        {!isLoading ? threads.map((thread) => {
          const current = thread.id === activeThreadId;
          const renaming = thread.id === renamingThreadId;
          const menuOpen = thread.id === menuThreadId;
          return (
            <div className="studio-history-item" data-current={current || undefined} key={thread.id}>
              {renaming ? (
                <input
                  aria-label="Session title"
                  className="studio-history-rename-input"
                  onBlur={() => void finishRename(thread)}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void finishRename(thread);
                    }
                    if (event.key === "Escape") setRenamingThreadId(undefined);
                  }}
                  ref={inputRef}
                  value={draftTitle}
                />
              ) : (
                <button
                  aria-current={current ? "page" : undefined}
                  className="studio-history-item-select"
                  onClick={() => {
                    onSelect(thread.id);
                    onClose();
                  }}
                  type="button"
                >
                  <span className="studio-history-item-title">{thread.title}</span>
                  <span className="studio-history-item-meta">
                    {formatUpdatedAt(thread.updatedAt)}
                    {current ? <span className="studio-history-current"><CheckIcon aria-hidden="true" size={11} />Current</span> : null}
                  </span>
                </button>
              )}
              <button
                aria-expanded={menuOpen}
                aria-label={`Manage ${thread.title}`}
                className="studio-history-item-more"
                onClick={() => setMenuThreadId((currentId) => currentId === thread.id ? undefined : thread.id)}
                type="button"
              >
                <MoreHorizontalIcon aria-hidden="true" size={16} />
              </button>
              {menuOpen ? (
                <div aria-label={`Manage ${thread.title}`} className="studio-history-item-actions" role="menu">
                  <button onClick={() => beginRename(thread)} role="menuitem" type="button">
                    <PencilIcon aria-hidden="true" size={14} />Rename
                  </button>
                  <button className="is-destructive" onClick={() => void removeThread(thread)} role="menuitem" type="button">
                    <Trash2Icon aria-hidden="true" size={14} />Delete
                  </button>
                </div>
              ) : null}
            </div>
          );
        }) : null}
      </div>
      {error ? <p className="studio-history-error" role="alert">{error}</p> : null}
      <button
        className="studio-history-new"
        disabled={isCreating}
        onClick={() => {
          void onCreate();
          onClose();
        }}
        type="button"
      >
        <PlusIcon aria-hidden="true" size={17} />
        New chat
      </button>
    </section>
  );
}

function HistoryLoading() {
  return (
    <div aria-label="Loading saved sessions" className="studio-history-loading" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";

  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "../components/motion/button";
import { publicError } from "../api/studio-api";
import { useStudioRouteContext } from "../layout/studio-route-context";
import { useStudioThreadMessagesQuery, useStudioThreadMutations } from "../queries/studio-queries";
import { StudioAssistant } from "../studio-assistant";
import { RouteError, RouteLoading } from "./route-state";

export function StudioChatRoute() {
  const { threadId: rawThreadId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const threadId = rawThreadId ? decodeURIComponent(rawThreadId) : undefined;
  const { activeThreadId, openSettings } = useStudioRouteContext();
  const messages = useStudioThreadMessagesQuery(threadId);
  const initialPromptRef = useRef(
    (location.state as { initialPrompt?: string } | null)?.initialPrompt,
  );

  useEffect(() => {
    if (location.state && "initialPrompt" in location.state) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  if (!threadId || (activeThreadId && activeThreadId !== threadId)) {
    return <Navigate replace to="/" />;
  }
  if (messages.isLoading) return <RouteLoading label="Loading analysis session" />;
  if (messages.error) return <RouteError message={publicError(messages.error)} />;

  return (
    <section aria-label="Data analysis conversation" className="studio-chat-route">
      <StudioAssistant
        initialMessages={messages.data ?? []}
        initialPrompt={initialPromptRef.current}
        key={threadId}
        onOpenSettings={openSettings}
        onThreadActivity={() => { void messages.refetch(); }}
        threadId={threadId}
      />
    </section>
  );
}

/** Root and /chat are both entry points into the sole Chat surface. */
export function StudioChatEntryRoute() {
  const navigate = useNavigate();
  const createMutation = useStudioThreadMutations().create;
  const requested = useRef(false);

  const openConversation = useCallback(async () => {
    if (requested.current || createMutation.isPending) return;
    requested.current = true;
    try {
      const created = await createMutation.mutateAsync();
      navigate(`/chat/${encodeURIComponent(created.id)}`, { replace: true });
    } catch {
      requested.current = false;
    }
  }, [createMutation, navigate]);

  useEffect(() => {
    void openConversation();
  }, [openConversation]);

  return (
    <section aria-label="Opening chat" className="studio-session-entry">
      {createMutation.error ? (
        <div className="studio-session-entry-error" role="alert">
          <CircleAlertIcon aria-hidden="true" size={16} />
          <span>Unable to start a chat.</span>
          <Button onClick={() => void openConversation()} size="sm" type="button" variant="secondary">
            Try again
          </Button>
        </div>
      ) : (
        <LoaderCircleIcon aria-label="Opening chat" className="studio-session-entry-spinner" size={18} />
      )}
    </section>
  );
}

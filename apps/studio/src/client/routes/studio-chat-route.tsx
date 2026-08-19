import { useEffect, useRef } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { Alert, AlertDescription } from "../components/ui/alert";
import { publicError } from "../api/studio-api";
import { useStudioRouteContext } from "../layout/studio-route-context";
import { useStudioThreadMessagesQuery } from "../queries/studio-queries";
import { StudioAssistant } from "../studio-assistant";
import { useRefreshStudioWorkspace } from "../queries/studio-queries";
import { RouteError, RouteLoading } from "./route-state";

export function StudioChatRoute() {
  const { threadId: rawThreadId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const threadId = rawThreadId ? decodeURIComponent(rawThreadId) : undefined;
  const { activeThreadId, workspace } = useStudioRouteContext();
  const refreshWorkspace = useRefreshStudioWorkspace();
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

  const ready = Boolean(
    workspace.connection.data?.connected
    && workspace.catalog.data
    && workspace.meta.data?.capabilities.chat,
  );

  return (
    <section aria-label="Data analysis conversation" className="studio-chat-route">
      {workspace.connection.error || workspace.catalog.error ? (
        <Alert className="studio-connection-notice" role="status">
          <AlertDescription>{publicError(workspace.connection.error ?? workspace.catalog.error)}</AlertDescription>
        </Alert>
      ) : null}
      <StudioAssistant
        initialMessages={messages.data ?? []}
        initialPrompt={initialPromptRef.current}
        isSendDisabled={!ready}
        key={threadId}
        modelLabel={workspace.model.data ?? "Model"}
        onDatabaseSettingsSaved={() => { void refreshWorkspace(); }}
        onThreadActivity={() => { void messages.refetch(); }}
        threadId={threadId}
      />
    </section>
  );
}

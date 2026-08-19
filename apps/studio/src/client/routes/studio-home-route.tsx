import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/motion/button";
import { useStudioThreadMutations } from "../queries/studio-queries";

/** The root URL is an entry point, not a separate product surface. */
export function StudioHomeRoute() {
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
    <section aria-label="Opening a new analysis" className="studio-session-entry">
      {createMutation.error ? (
        <div className="studio-session-entry-error" role="alert">
          <CircleAlertIcon aria-hidden="true" size={16} />
          <span>Unable to start a new analysis.</span>
          <Button onClick={() => void openConversation()} size="sm" type="button" variant="secondary">
            Try again
          </Button>
        </div>
      ) : (
        <LoaderCircleIcon aria-label="Opening a new analysis" className="studio-session-entry-spinner" size={18} />
      )}
    </section>
  );
}

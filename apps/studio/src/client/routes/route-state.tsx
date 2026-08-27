import { AlertDescription } from "../components/ui/alert";
import { StudioLoading } from "../components/studio-loading";

export function RouteLoading({ label }: { label: string }) {
  return <StudioLoading className="studio-route-loading" label={label} size="large" />;
}

export function RouteError({ message }: { message: string }) {
  return (
    <div className="studio-route-error" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </div>
  );
}

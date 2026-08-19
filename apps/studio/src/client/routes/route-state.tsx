import { AlertDescription } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";

export function RouteLoading({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="studio-route-loading">
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </div>
  );
}

export function RouteError({ message }: { message: string }) {
  return (
    <div className="studio-route-error" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </div>
  );
}

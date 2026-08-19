import { ActivityIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { useNavigate } from "react-router";
import { publicError } from "../api/studio-api";
import { Button } from "../components/motion/button";
import { useStudioRouteContext } from "../layout/studio-route-context";
import { RouteLoading } from "./route-state";

const TableEditor = lazy(() => import("../table-editor").then(({ TableEditor: Editor }) => ({ default: Editor })));

export function StudioDataRoute() {
  const navigate = useNavigate();
  const { workspace, refreshWorkspace } = useStudioRouteContext();
  const catalog = workspace.catalog.data;

  return (
    <section aria-label="Database data explorer" className="studio-data-route">
      <div className="studio-page-heading">
        <div>
          <span className="studio-page-kicker">Workspace / database</span>
          <h1>Data explorer</h1>
          <p>Inspect tables, definitions, and representative rows without leaving the workspace.</p>
        </div>
        <Button className="studio-secondary-button" onClick={() => void refreshWorkspace()} size="sm" variant="secondary">
          <ActivityIcon size={15} /> Refresh catalog
        </Button>
      </div>
      <div className="studio-data-frame">
        {catalog ? (
          <Suspense fallback={<RouteLoading label="Loading data explorer" />}>
            <TableEditor
              catalog={catalog}
              catalogError={workspace.catalog.error ? publicError(workspace.catalog.error) : undefined}
              connection={workspace.connection.data}
              connectionError={workspace.connection.error ? publicError(workspace.connection.error) : undefined}
              onClose={() => navigate(-1)}
              onRefreshCatalog={() => void refreshWorkspace()}
              refreshingCatalog={workspace.catalog.isFetching}
            />
          </Suspense>
        ) : <RouteLoading label="Loading database catalog" />}
      </div>
    </section>
  );
}

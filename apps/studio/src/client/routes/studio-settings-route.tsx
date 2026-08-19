import { DatabaseIcon, GaugeIcon, Settings2Icon, ShieldCheckIcon } from "lucide-react";
import { NavLink, Navigate, useParams } from "react-router";
import { useStudioRouteContext } from "../layout/studio-route-context";
import { StudioSettingsDialog, type StudioSettingsTab } from "../studio-settings";

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: StudioSettingsTab;
  label: string;
  description: string;
  icon: typeof DatabaseIcon;
}> = [
  { id: "database", label: "Database", description: "Connection and access", icon: DatabaseIcon },
  { id: "model", label: "Model", description: "Provider and reasoning", icon: Settings2Icon },
  { id: "limits", label: "Limits", description: "Rows, time, and steps", icon: GaugeIcon },
  { id: "permissions", label: "Permissions", description: "Action approval policy", icon: ShieldCheckIcon },
];

export function StudioSettingsRoute() {
  const { section } = useParams();
  const { refreshWorkspace } = useStudioRouteContext();

  if (section && !SETTINGS_SECTIONS.some((item) => item.id === section)) {
    return <Navigate replace to="/settings/database" />;
  }

  const activeSection = (section ?? "database") as StudioSettingsTab;

  return (
    <section aria-label="Workspace settings" className="studio-settings-route">
      <div className="studio-page-heading">
        <div>
          <span className="studio-page-kicker">Workspace / preferences</span>
          <h1>Settings</h1>
          <p>Keep the database, model, permissions, and execution limits aligned with this workspace.</p>
        </div>
        <span className="studio-settings-status">Changes stay local</span>
      </div>
      <div className="studio-settings-layout">
        <nav aria-label="Settings sections" className="studio-settings-nav">
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.id} to={`/settings/${item.id}`}>
                <Icon aria-hidden="true" size={16} />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
              </NavLink>
            );
          })}
        </nav>
        <StudioSettingsDialog
          initialTab={activeSection}
          onOpenChange={() => undefined}
          onSaved={() => { void refreshWorkspace(); }}
          open
          variant="page"
        />
      </div>
    </section>
  );
}

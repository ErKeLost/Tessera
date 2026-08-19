import { HomeIcon, Table2Icon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Dock, DockItem } from "../components/motion/dock";

export function StudioDock() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="studio-dock-wrap">
      <Dock size={38}>
        <DockItem active={location.pathname === "/"} aria-label="Home" onClick={() => navigate("/")}>
          <HomeIcon size={17} />
        </DockItem>
        <DockItem active={location.pathname.startsWith("/data")} aria-label="Data explorer" onClick={() => navigate("/data")}>
          <Table2Icon size={17} />
        </DockItem>
      </Dock>
    </div>
  );
}

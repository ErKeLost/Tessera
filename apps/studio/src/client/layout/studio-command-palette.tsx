import { ContrastIcon, HomeIcon, Table2Icon } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import {
  CommandPalette,
  type CommandItem,
} from "../components/motion/command-palette";
import { useStudioUiStore } from "../store/studio-ui-store";

export function StudioCommandPalette() {
  const open = useStudioUiStore((state) => state.commandPaletteOpen);
  const setOpen = useStudioUiStore((state) => state.setCommandPaletteOpen);
  const setGlass = useStudioUiStore((state) => state.setGlass);
  const navigate = useNavigate();
  const items: CommandItem[] = useMemo(() => [
    { id: "home", label: "Go to home", group: "Navigate", icon: HomeIcon, onSelect: () => navigate("/") },
    { id: "data", label: "Open data explorer", group: "Navigate", icon: Table2Icon, onSelect: () => navigate("/data") },
    {
      id: "glass",
      label: "Toggle glass surfaces",
      group: "Appearance",
      icon: ContrastIcon,
      onSelect: () => setGlass(!useStudioUiStore.getState().glass),
    },
  ], [navigate, setGlass]);

  return (
    <CommandPalette
      items={items}
      onOpenChange={setOpen}
      open={open}
      placeholder="Search workspace commands..."
    />
  );
}

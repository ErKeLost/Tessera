import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type StudioUiState = {
  commandPaletteOpen: boolean;
  glass: boolean;
  sidebarOpen: boolean;
  setCommandPaletteOpen(open: boolean): void;
  setGlass(glass: boolean): void;
  setSidebarOpen(open: boolean): void;
};

/**
 * Workspace-only preferences belong here. Server resources stay in React Query
 * so a stale interface preference can never overwrite live connection data.
 */
export const useStudioUiStore = create<StudioUiState>()(
  persist(
    (set) => ({
      commandPaletteOpen: false,
      glass: true,
      sidebarOpen: true,
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      setGlass: (glass) => set({ glass }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    }),
    {
      name: "chat-glass",
      partialize: (state) => ({ glass: state.glass, sidebarOpen: state.sidebarOpen }),
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        if (typeof persisted === "boolean") return { ...current, glass: persisted };
        return { ...current, ...(persisted as Partial<StudioUiState> | null) };
      },
    },
  ),
);

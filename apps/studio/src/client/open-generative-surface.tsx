"use client";

import {
  officialRendererReleaseSchema,
} from "@open-generative/components";
import {
  openGenerativeFallbackSchema,
  openGenerativeSurfaceStreamSchema,
} from "@open-generative/protocol";
import {
  OpenGenerativeRenderer,
  OpenGenerativeThemeProvider,
} from "@open-generative/ui";
import rendererRelease from "@open-generative/ui/renderer-release.json";
import { useStudioRouteContext } from "./layout/studio-route-context";
import { openGenerativeThemeFor } from "./open-generative-theme";
import { useStudioTheme } from "./studio-theme";
import { dispatchStudioOpenGenerativeCommand } from "./api/studio-api";
import { OpenGenerativeInspector } from "./open-generative-inspector";

const verifiedRendererRelease = officialRendererReleaseSchema.parse(rendererRelease);

export function OpenGenerativeSurfaceDataRenderer({ data }: { data: unknown }) {
  const { resolvedTheme } = useStudioTheme();
  const { workspace } = useStudioRouteContext();
  const stream = openGenerativeSurfaceStreamSchema.safeParse(data);
  if (!stream.success) return <OpenGenerativeSurfaceError error={stream.error} />;
  const generativeUi = workspace.meta.data?.generativeUi;
  return (
    <OpenGenerativeThemeProvider
      className="tessera-generative-surface"
      theme={openGenerativeThemeFor(
        resolvedTheme,
        workspace.meta.data?.generativeUi.themePreset,
      )}
    >
      {generativeUi?.inspectorEnabled ? (
        <div className="tessera-generative-surface-tools">
          <OpenGenerativeInspector
            hostDeployment={generativeUi.hostDeployment}
            surfaceSessionId={stream.data.surfaceSessionId}
          />
        </div>
      ) : null}
      <OpenGenerativeRenderer
        className="tessera-generative-renderer"
        errorFallback={(error) => <OpenGenerativeSurfaceError error={error} />}
        onCommand={dispatchStudioOpenGenerativeCommand}
        stream={stream.data}
        locale="en-US"
        rendererRelease={verifiedRendererRelease}
        timezone="Asia/Shanghai"
      />
    </OpenGenerativeThemeProvider>
  );
}

export function OpenGenerativeFallbackDataRenderer({ data }: { data: unknown }) {
  const message = openGenerativeFallbackErrorMessage(data);
  if (message === undefined) return null;
  return <OpenGenerativeSurfaceError error={message} />;
}

const DEFAULT_SURFACE_ERROR = "The generated surface could not be validated by the installed component catalog.";
const DEFAULT_FALLBACK_ERROR = "The generated Open Generative Language could not be compiled.";

export function openGenerativeSurfaceErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : undefined;
  const normalized = message?.trim();
  return normalized ? normalized.slice(0, 2_000) : DEFAULT_SURFACE_ERROR;
}

export function openGenerativeFallbackErrorMessage(data: unknown): string | undefined {
  const fallback = openGenerativeFallbackSchema.safeParse(data);
  if (!fallback.success) return undefined;
  return fallback.data.diagnostic ?? DEFAULT_FALLBACK_ERROR;
}

function OpenGenerativeSurfaceError({ error }: Readonly<{ error?: unknown }>) {
  return (
    <div className="tessera-generative-surface-error" role="alert">
      <strong>Unable to render this analysis</strong>
      <span>{openGenerativeSurfaceErrorMessage(error)}</span>
    </div>
  );
}

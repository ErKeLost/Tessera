"use client";

import {
  officialRendererReleaseSchema,
} from "@open-generative/components";
import {
  openGenerativeSurfaceStreamSchema,
} from "@open-generative/protocol";
import { OpenGenerativeRenderer } from "@open-generative/ui";
import rendererRelease from "@open-generative/ui/renderer-release.json";

const verifiedRendererRelease = officialRendererReleaseSchema.parse(rendererRelease);

export function OpenGenerativeSurfaceDataRenderer({ data }: { data: unknown }) {
  const stream = openGenerativeSurfaceStreamSchema.safeParse(data);
  if (!stream.success) return <OpenGenerativeSurfaceError />;
  return (
    <OpenGenerativeRenderer
      className="tessera-generative-surface"
      errorFallback={() => <OpenGenerativeSurfaceError />}
      stream={stream.data}
      locale="en-US"
      rendererRelease={verifiedRendererRelease}
      timezone="Asia/Shanghai"
    />
  );
}

function OpenGenerativeSurfaceError() {
  return (
    <div className="tessera-generative-surface-error" role="alert">
      <strong>Unable to render this analysis</strong>
      <span>The generated surface did not match the installed component catalog.</span>
    </div>
  );
}

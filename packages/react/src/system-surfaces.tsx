import type { ReactElement } from "react";
import type {
  EmptySystemSurfaceInput,
  ErrorSystemSurfaceInput,
  LoadingSystemSurfaceInput,
  SystemSurfaceRenderers,
  UnsupportedSystemSurfaceInput,
} from "./types";

export function DefaultLoadingSystemSurface({
  scope,
}: LoadingSystemSurfaceInput): ReactElement {
  return (
    <div
      aria-live="polite"
      data-open-generative-scope={scope}
      data-open-generative-system="loading"
      role="status"
    >
      Loading generated content.
    </div>
  );
}

export function DefaultEmptySystemSurface(
  _input: EmptySystemSurfaceInput,
): ReactElement {
  return (
    <div data-open-generative-system="empty" role="status">
      No generated content.
    </div>
  );
}

export function DefaultErrorSystemSurface({
  scope,
}: ErrorSystemSurfaceInput): ReactElement {
  return (
    <div
      data-open-generative-scope={scope}
      data-open-generative-system="error"
      role="alert"
    >
      Generated content is unavailable.
    </div>
  );
}

export function DefaultUnsupportedSystemSurface(
  _input: UnsupportedSystemSurfaceInput,
): ReactElement {
  return (
    <div data-open-generative-system="unsupported" role="status">
      This generated component is not supported.
    </div>
  );
}

export const defaultSystemSurfaces: SystemSurfaceRenderers = Object.freeze({
  loading: DefaultLoadingSystemSurface,
  empty: DefaultEmptySystemSurface,
  error: DefaultErrorSystemSurface,
  unsupported: DefaultUnsupportedSystemSurface,
});

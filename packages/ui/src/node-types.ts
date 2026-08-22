import type {
  ArtifactDocument,
  ArtifactNode,
  Diagnostic,
  JsonValue,
  RuntimeSnapshot,
} from "@open-tessera/runtime";
import type { ComponentType, ReactNode } from "react";

export type EvaluatedArtifactNodeProps = Record<string, JsonValue>;

export type ArtifactNodeTrigger = (
  port: string,
  payload?: JsonValue,
) => Promise<{ ok: true } | { ok: false; diagnostic: Diagnostic }>;

export type ArtifactNodeRendererProps<TProps extends object = EvaluatedArtifactNodeProps> = {
  nodeId: string;
  node: ArtifactNode;
  value: TProps;
  props: TProps;
  document: ArtifactDocument;
  snapshot?: RuntimeSnapshot;
  slots: Readonly<Record<string, ReactNode[]>>;
  children: ReactNode;
  locale?: string;
  timezone?: string;
  diagnostics: readonly Diagnostic[];
  canTrigger: (port: string) => boolean;
  trigger: ArtifactNodeTrigger;
};

export type ArtifactNodeRenderer<TProps extends object = EvaluatedArtifactNodeProps> =
  ComponentType<ArtifactNodeRendererProps<TProps>>;

export type ArtifactNodeRendererRegistry = Readonly<Record<string, ArtifactNodeRenderer<any>>>;

export type ArtifactNodeEventPayloadValidation =
  | { success: true }
  | { success: false; message: string };

export type ArtifactNodeEventPayloadValidator = (
  payload: JsonValue,
) => ArtifactNodeEventPayloadValidation;

export type ArtifactNodeEventPayloadValidatorRegistry = Readonly<Record<
  string,
  Readonly<Record<string, ArtifactNodeEventPayloadValidator>>
>>;

export function defineArtifactNodeRenderer<TProps extends object>(
  component: ArtifactNodeRenderer<TProps>,
): ArtifactNodeRenderer<TProps> {
  return component;
}

export function defineArtifactNodeEventPayloadValidators<TRegistry extends ArtifactNodeEventPayloadValidatorRegistry>(
  registry: TRegistry,
): TRegistry {
  return registry;
}

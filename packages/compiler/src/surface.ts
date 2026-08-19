import type { Artifact } from "@data-elements/schema";
import type {
  ArtifactProposal,
  AuthoringNode,
  AuthoringValue,
  ConditionOperator,
  PathSegment,
} from "./types";

type NodeBase = {
  id: string;
  events?: Record<string, string>;
  evidence?: string[];
};

function authoringProps(
  value: Record<string, AuthoringValue | undefined>,
): Record<string, AuthoringValue> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Record<string, AuthoringValue>;
}

function attachBase(
  node: AuthoringNode,
  input: Pick<NodeBase, "events" | "evidence">,
): AuthoringNode {
  if (input.events) node.events = input.events;
  if (input.evidence) node.evidence = input.evidence;
  return node;
}

function leaf(
  type: string,
  input: NodeBase,
  props: Record<string, AuthoringValue>,
): AuthoringNode {
  return attachBase({
    id: input.id,
    type,
    props,
  }, input);
}

export const reference = Object.freeze({
  state(id: string, path?: PathSegment[]): AuthoringValue {
    return path ? { $ref: "state", id, path } : { $ref: "state", id };
  },
  resource(id: string, path?: PathSegment[]): AuthoringValue {
    return path ? { $ref: "resource", id, path } : { $ref: "resource", id };
  },
  event(port: string, path?: PathSegment[]): AuthoringValue {
    return path ? { $ref: "event", port, path } : { $ref: "event", port };
  },
  context(key: "locale" | "timezone"): AuthoringValue {
    return { $ref: "context", key };
  },
});

export function condition(
  op: ConditionOperator,
  ...args: AuthoringValue[]
): AuthoringValue {
  return { $condition: { op, args } };
}

export const surface = Object.freeze({
  node(input: AuthoringNode): AuthoringNode {
    return input;
  },

  stack(input: NodeBase & {
    children: AuthoringNode[];
    gap?: "none" | "xs" | "sm" | "md" | "lg" | "xl";
    align?: "start" | "center" | "end" | "stretch";
  }): AuthoringNode {
    return attachBase({
      id: input.id,
      type: "layout.stack",
      props: authoringProps({ gap: input.gap, align: input.align }),
      slots: { children: input.children },
    }, input);
  },

  grid(input: NodeBase & {
    children: AuthoringNode[];
    columns?: 1 | 2 | 3 | 4;
    gap?: "none" | "xs" | "sm" | "md" | "lg" | "xl";
    align?: "start" | "center" | "end" | "stretch";
  }): AuthoringNode {
    return attachBase({
      id: input.id,
      type: "layout.grid",
      props: authoringProps({ columns: input.columns, gap: input.gap, align: input.align }),
      slots: { children: input.children },
    }, input);
  },

  section(input: NodeBase & {
    children: AuthoringNode[];
    title?: string;
    description?: string;
  }): AuthoringNode {
    return attachBase({
      id: input.id,
      type: "layout.section",
      props: authoringProps({ title: input.title, description: input.description }),
      slots: { children: input.children },
    }, input);
  },

  text(input: NodeBase & {
    text: string;
    role?: "heading" | "paragraph" | "caption";
    tone?: "default" | "muted" | "positive" | "warning" | "critical";
  }): AuthoringNode {
    return leaf("content.text", input, {
      text: input.text,
      ...(input.role ? { role: input.role } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
    });
  },

  callout(input: NodeBase & {
    body: string;
    title?: string;
    tone?: "info" | "success" | "warning" | "critical";
  }): AuthoringNode {
    return leaf("content.callout", input, {
      body: input.body,
      ...(input.title ? { title: input.title } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
    });
  },

  progress(input: NodeBase & { label: string; value: number; detail?: string }): AuthoringNode {
    return leaf("content.progress", input, {
      label: input.label,
      value: input.value,
      ...(input.detail ? { detail: input.detail } : {}),
    });
  },

  empty(input: NodeBase & {
    title: string;
    description?: string;
    reason?: "no-data" | "filtered" | "unavailable" | "not-applicable";
  }): AuthoringNode {
    return leaf("content.empty", input, {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  },

  form(input: NodeBase & {
    fields: AuthoringNode[];
    title?: string;
    description?: string;
  }): AuthoringNode {
    return attachBase({
      id: input.id,
      type: "form.root",
      props: authoringProps({ title: input.title, description: input.description }),
      slots: { fields: input.fields },
    }, input);
  },

  input(input: NodeBase & {
    label: string;
    inputType?: "text" | "email" | "number" | "date";
    value?: AuthoringValue;
    placeholder?: string;
    description?: string;
    required?: boolean;
    disabled?: AuthoringValue;
  }): AuthoringNode {
    return leaf("form.input", input, authoringProps({
      label: input.label,
      inputType: input.inputType,
      value: input.value,
      placeholder: input.placeholder,
      description: input.description,
      required: input.required,
      disabled: input.disabled,
    }));
  },

  select(input: NodeBase & {
    label: string;
    options?: AuthoringValue;
    value?: AuthoringValue;
    placeholder?: string;
    description?: string;
    required?: boolean;
    disabled?: AuthoringValue;
  }): AuthoringNode {
    return leaf("form.select", input, authoringProps({
      label: input.label,
      options: input.options,
      value: input.value,
      placeholder: input.placeholder,
      description: input.description,
      required: input.required,
      disabled: input.disabled,
    }));
  },

  toggle(input: NodeBase & {
    label: string;
    description?: string;
    checked?: AuthoringValue;
    disabled?: AuthoringValue;
  }): AuthoringNode {
    return leaf("form.toggle", input, authoringProps({
      label: input.label,
      description: input.description,
      checked: input.checked,
      disabled: input.disabled,
    }));
  },

  button(input: NodeBase & {
    label: string;
    type?: "button" | "submit" | "reset";
    variant?: "default" | "secondary" | "destructive";
    disabled?: AuthoringValue;
  }): AuthoringNode {
    return leaf("form.button", input, authoringProps({
      label: input.label,
      type: input.type,
      variant: input.variant,
      disabled: input.disabled,
    }));
  },

  artifact(artifact: Artifact, options: {
    id?: string;
    events?: Record<string, string>;
    evidence?: string[];
  } = {}): AuthoringNode {
    return attachBase({
      id: options.id ?? artifact.id,
      type: `artifact.${artifact.kind}`,
      props: projectArtifactToNodeProps(artifact),
    }, options);
  },
});

export function projectArtifactToNodeProps(
  artifact: Artifact,
): Record<string, AuthoringValue> {
  const {
    protocolVersion: _protocolVersion,
    kind: _kind,
    id: _id,
    ...props
  } = artifact;
  return props as unknown as Record<string, AuthoringValue>;
}

export function defineSurface(
  input: AuthoringNode | ArtifactProposal,
): ArtifactProposal {
  if ("root" in input) return input;
  return { root: input };
}

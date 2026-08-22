"use client";

import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

type NodeErrorBoundaryProps = Readonly<{
  children: ReactNode;
  fallback: (error: unknown) => ReactNode;
  onError: (error: unknown, info: ErrorInfo) => void;
  resetKey: string;
  resetToken: unknown;
}>;

type NodeErrorBoundaryState = Readonly<{
  failed: boolean;
  error?: unknown;
  resetKey: string;
  resetToken: unknown;
}>;

export class NodeErrorBoundary extends Component<
  NodeErrorBoundaryProps,
  NodeErrorBoundaryState
> {
  state: NodeErrorBoundaryState;

  constructor(props: NodeErrorBoundaryProps) {
    super(props);
    this.state = cleanState(props);
  }

  static getDerivedStateFromProps(
    props: NodeErrorBoundaryProps,
    state: NodeErrorBoundaryState,
  ): NodeErrorBoundaryState | null {
    return props.resetKey !== state.resetKey || props.resetToken !== state.resetToken
      ? cleanState(props)
      : null;
  }

  static getDerivedStateFromError(error: unknown): Partial<NodeErrorBoundaryState> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  render(): ReactNode {
    return this.state.failed
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

function cleanState(props: NodeErrorBoundaryProps): NodeErrorBoundaryState {
  return {
    failed: false,
    resetKey: props.resetKey,
    resetToken: props.resetToken,
  };
}

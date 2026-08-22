"use client";

import { ArtifactRenderer } from "@open-generative/ui";
import {
  decodeArtifactPart,
  type ArtifactPart,
  type ArtifactPartWire,
} from "@open-tessera/runtime";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import styles from "./background.module.css";

export type ArtifactPayload = {
  artifactProtocol: "2.0";
  contractFingerprint: string;
  part: ArtifactPartWire;
};

type ArtifactDecodeState =
  | { status: "loading" }
  | { status: "ready"; part: ArtifactPart }
  | { status: "invalid"; detail: string };

export type DecodedArtifactProps = {
  payload: unknown;
};

export const DecodedArtifact = memo(function DecodedArtifact({ payload }: DecodedArtifactProps) {
  const [state, setState] = useState<ArtifactDecodeState>({ status: "loading" });

  useEffect(() => {
    let current = true;

    if (!isArtifactPayload(payload)) {
      setState({ status: "invalid", detail: "响应中的 Artifact 格式不正确。" });
      return () => {
        current = false;
      };
    }

    setState({ status: "loading" });
    void decodeArtifactPart(payload.part, { contractFingerprint: payload.contractFingerprint })
      .then((result) => {
        if (!current) return;
        if (result.success) {
          setState({ status: "ready", part: result.part });
          return;
        }
        setState({
          status: "invalid",
          detail: result.diagnostics.at(0)?.message ?? "Artifact 未通过客户端校验。",
        });
      })
      .catch(() => {
        if (current) setState({ status: "invalid", detail: "Artifact 客户端校验未完成。" });
      });

    return () => {
      current = false;
    };
  }, [payload]);

  if (state.status === "loading") {
    return (
      <section aria-label="正在验证 Artifact" className={styles.artifactLoading}>
        <LoaderCircleIcon aria-hidden="true" />
        <span>正在验证 Artifact</span>
      </section>
    );
  }

  if (state.status === "invalid") {
    return (
      <section className={styles.artifactInvalid} role="alert">
        <CircleAlertIcon aria-hidden="true" />
        <div>
          <strong>Artifact 未通过客户端校验</strong>
          <p>{state.detail}</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="生成的 Artifact" className={styles.artifactSurface}>
      <div className={styles.artifactHeader}>
        <span>Artifact</span>
        <span>validated</span>
      </div>
      <div className={styles.artifactBody}>
        <ArtifactRenderer
          errorFallback={<p className={styles.artifactFallback}>Artifact 无法完成渲染。</p>}
          fallback={<p className={styles.artifactFallback}>当前 Artifact 类型没有可用的渲染器。</p>}
          locale="zh-CN"
          value={state.part}
        />
      </div>
    </section>
  );
});

DecodedArtifact.displayName = "DecodedArtifact";

function isArtifactPayload(value: unknown): value is ArtifactPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.artifactProtocol === "2.0"
    && typeof data.contractFingerprint === "string"
    && data.part !== null
    && typeof data.part === "object"
    && !Array.isArray(data.part);
}

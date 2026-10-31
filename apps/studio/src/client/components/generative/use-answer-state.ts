"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAnswerState, type AnswerState } from "../../../generative/answer-state";
import { requestJson } from "../../api/studio-api";

/** State stays in Studio's UI store; it never changes the model's private history. */
export function useAnswerState(threadId: string | undefined, messageId: string, response: string, streaming: boolean) {
  const [loaded, setLoaded] = useState<{ response: string; state: AnswerState }>();
  const endpoint = useRef<string | undefined>(undefined);
  const pending = useRef<AnswerState | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writes = useRef(Promise.resolve());

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const url = endpoint.current;
    const state = pending.current;
    pending.current = undefined;
    if (!url || !state) return;
    // Serialize snapshots so an older response can never win over the latest edit.
    writes.current = writes.current.catch(() => {}).then(async () => {
      await requestJson(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state), keepalive: true });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (streaming || !threadId || !response.trim()) return;
    const controller = new AbortController();
    endpoint.current = undefined;
    void (async () => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(response));
      const hash = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
      const url = `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/state/${hash}`;
      const result = await requestJson<{ state: AnswerState }>(url, { signal: controller.signal });
      if (!controller.signal.aborted) { endpoint.current = url; setLoaded({ response, state: result.state }); }
    })().catch(() => { if (!controller.signal.aborted) setLoaded({ response, state: {} }); });
    return () => { controller.abort(); flush(); };
  }, [threadId, messageId, response, streaming, flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [flush]);

  const update = useCallback((state: AnswerState) => {
    if (!isAnswerState(state) || !endpoint.current) return;
    pending.current = state;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [flush]);
  return { ready: streaming || !threadId || loaded?.response === response, initialState: loaded?.response === response ? loaded.state : undefined, update };
}

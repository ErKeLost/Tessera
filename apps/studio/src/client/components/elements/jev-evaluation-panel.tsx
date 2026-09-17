"use client";

import { useEffect, useRef, useState } from "react";
import type { StudioSettingsCandidate } from "../../studio-settings";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { StudioProviderIcon } from "./provider-icon";

const exampleQuestions = JSON.stringify({
  refunded: { type: "boolean", instructions: "Was a refund issued?" },
}, null, 2);

export function JevEvaluationPanel({ settings, disabled }: { settings?: StudioSettingsCandidate; disabled: boolean }) {
  const [state, setState] = useState("The support agent issued a full refund to the customer.");
  const [questions, setQuestions] = useState(exampleQuestions);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (!settings || running) return;
    setError(undefined);
    setResult(undefined);
    let parsedQuestions: unknown;
    let parsedState: unknown = state;
    try {
      parsedQuestions = JSON.parse(questions);
    } catch {
      setError("Questions must be valid JSON.");
      return;
    }
    // Accept structured JSON as well as ordinary text, as the evaluation API does.
    try {
      const value: unknown = JSON.parse(state);
      if (value !== null && typeof value === "object") parsedState = value;
    } catch { /* Plain text state. */ }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const response = await fetch("/api/settings/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, evaluation: { state: parsedState, questions: parsedQuestions } }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "Evaluation failed.");
      if (!controller.signal.aborted) setResult(JSON.stringify(body, null, 2));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Evaluation failed.");
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  return (
    <section aria-label="Jev evaluation" className="grid gap-3 rounded-xl border border-border p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium"><StudioProviderIcon provider="vercel" />Jev evaluation</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        Try typesafe-ai/jev with the Vercel Gateway key above. Ask boolean, choice or score questions about shared state. Your chat model stays selected.
      </p>
      <Label htmlFor="jev-state">State</Label>
      <Textarea id="jev-state" disabled={running} value={state} onChange={(event) => setState(event.target.value)} rows={3} />
      <Label htmlFor="jev-questions">Questions (JSON)</Label>
      <Textarea className="font-mono text-xs" id="jev-questions" disabled={running} value={questions} onChange={(event) => setQuestions(event.target.value)} rows={7} />
      <a className="text-xs text-muted-foreground underline underline-offset-4" href="https://vercel.com/docs/ai-gateway/modalities/evaluation" target="_blank" rel="noreferrer">Question types and examples</a>
      <Button className="justify-self-start" type="button" variant="outline" disabled={disabled || running || !settings || !state.trim()} onClick={() => void run()}>
        {running ? "Evaluating…" : "Run Jev evaluation"}
      </Button>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      {result ? <pre aria-label="Evaluation result" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs" role="status">{result}</pre> : null}
    </section>
  );
}

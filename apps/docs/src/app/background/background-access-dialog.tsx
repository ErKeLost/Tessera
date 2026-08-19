"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type BackgroundAccessDialogProps = {
  open: boolean;
  onGranted(): void;
  onOpenChange(open: boolean): void;
};

export function BackgroundAccessDialog({
  open,
  onGranted,
  onOpenChange,
}: BackgroundAccessDialogProps) {
  const [accessToken, setAccessToken] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = accessToken.trim();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/background/access", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      if (!response.ok) {
        setError(await responseError(response));
        return;
      }
      setAccessToken("");
      onOpenChange(false);
      onGranted();
    } catch {
      setError("无法建立访问会话，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>访问 Playground</DialogTitle>
          <DialogDescription>输入访问令牌以继续使用此环境。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Input
            aria-label="访问令牌"
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => setAccessToken(event.currentTarget.value)}
            placeholder="访问令牌"
            type="password"
            value={accessToken}
          />
          {error ? <p className="text-destructive text-sm" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button disabled={!accessToken.trim() || submitting} type="submit">
              {submitting ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
              继续
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError();
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) throw new TypeError();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // All server failures have a stable fallback below.
  }
  return "无法建立访问会话，请稍后重试。";
}

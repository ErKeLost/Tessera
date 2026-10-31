import { useEffect, useState } from "react";
import { CopyIcon, FileTextIcon, LinkIcon } from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Field, FieldGroup } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { requestJson } from "./api/studio-api";
import { useStudioFeishuQuery } from "./queries/studio-queries";

export function FeishuAuthorizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const status = useStudioFeishuQuery(open);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(() => new URL(window.location.href).searchParams.get("feishu") === "error" ? "授权未完成，请检查应用权限和回调地址后重新连接。" : undefined);
  const callbackUrl = `${window.location.origin}/api/feishu/callback`;
  useEffect(() => { if (status.data?.appId) setAppId(status.data.appId); }, [status.data?.appId]);

  const connect = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await requestJson("/api/feishu", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, ...(appSecret ? { appSecret } : {}) }) });
      setAppSecret("");
      const result = await requestJson<{ url: string }>("/api/feishu/connect", { method: "POST" });
      const url = new URL(result.url);
      if (url.origin !== "https://open.feishu.cn" || url.pathname !== "/open-apis/authen/v1/authorize") throw new Error("授权地址无效，请重试。");
      window.location.assign(url.toString());
    } catch (failure) { setError(failure instanceof Error ? failure.message : "飞书授权失败，请重试。"); setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(undefined);
    try { await requestJson("/api/feishu", { method: "DELETE" }); await status.refetch(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法断开连接。"); }
    finally { setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="tessera-settings-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FileTextIcon size={19} />{status.data?.connected ? "飞书已连接" : "连接飞书文档"}</DialogTitle>
        <DialogDescription>授权后，Agent 可以搜索和读取此飞书账号有权限的云文档与知识库文档。当前工作区共用此连接。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <p className="text-sm leading-6 text-muted-foreground">在<a className="underline underline-offset-4" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台</a>创建企业自建应用，开启以下用户权限，发布版本并将自己加入应用可用范围。</p>
        <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-6">
          <div>搜索云文档：<code>docs:doc:readonly</code></div>
          <div>读取新版文档：<code>docx:document:readonly</code></div>
          <div>读取知识库：<code>wiki:wiki:readonly</code></div>
          <div>续期授权：<code>offline_access</code></div>
        </div>
        <Field>
          <Label htmlFor="feishu-callback">重定向 URL</Label>
          <div className="flex items-center gap-2"><Input id="feishu-callback" readOnly value={callbackUrl} /><Button aria-label="复制重定向 URL" onClick={() => void navigator.clipboard.writeText(callbackUrl)} size="icon" type="button" variant="outline"><CopyIcon size={15} /></Button></div>
          <p className="text-xs leading-5 text-muted-foreground">将此地址填写到应用「安全设置 → 重定向 URL」。工作台应用主页使用 {window.location.origin}/feishu。</p>
        </Field>
        <Field><Label htmlFor="feishu-app-id">App ID</Label><Input id="feishu-app-id" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off" disabled={busy} /></Field>
        <Field><Label htmlFor="feishu-app-secret">App Secret</Label><Input id="feishu-app-secret" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={status.data?.configured ? "已加密保存；留空保留" : "填写应用凭据"} autoComplete="new-password" disabled={busy} /></Field>
        {error || status.error ? <p role="alert" className="text-sm text-destructive">{error ?? status.error?.message}</p> : null}
      </FieldGroup>
      <DialogFooter>
        {status.data?.connected ? <Button disabled={busy} type="button" variant="outline" onClick={() => void disconnect()}>断开连接</Button> : null}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>稍后</Button>
        <Button type="button" disabled={busy || !appId.trim() || (!appSecret && !status.data?.configured) || status.data?.available === false} onClick={() => void connect()}><LinkIcon size={15} />{busy ? "正在连接…" : status.data?.connected ? "重新授权" : "保存并授权"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

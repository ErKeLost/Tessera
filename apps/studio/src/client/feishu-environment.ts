/** UI routing only. Feishu OAuth and the API enforce authorization independently. */
export function isFeishuEnvironment(input: { pathname: string; userAgent?: string; referrer?: string }): boolean {
  if (/^\/feishu(?:\/|$)/u.test(input.pathname)) return true;
  if (/\b(?:Lark|Feishu)\//iu.test(input.userAgent ?? "")) return true;
  if (input.referrer) {
    try { return /(^|\.)(feishu\.cn|larksuite\.com)$/iu.test(new URL(input.referrer).hostname); }
    catch { return false; }
  }
  return false;
}

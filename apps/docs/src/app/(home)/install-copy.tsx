"use client";

import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useState } from "react";
import styles from "./home.module.css";

export function InstallCopy({
  command,
  tone = "hero",
}: {
  command: string;
  tone?: "console" | "hero";
}) {
  const [copied, setCopied] = useState(false);
  const { locale } = useI18n();
  const copiedLabel = locale === "zh" ? "已复制" : "Copied";
  const copyLabel = locale === "zh" ? "复制安装命令" : "Copy install command";

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={`${styles.installCopy} ${tone === "console" ? styles.installCopyConsole : ""}`}>
      <span aria-hidden="true">$</span>
      <code>{command}</code>
      <button
        aria-label={copied ? copiedLabel : copyLabel}
        onClick={() => void copy()}
        title={copied ? copiedLabel : copyLabel}
        type="button"
      >
        {copied ? <CheckIcon aria-hidden="true" /> : <ClipboardIcon aria-hidden="true" />}
      </button>
    </div>
  );
}

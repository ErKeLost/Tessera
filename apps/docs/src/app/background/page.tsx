import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import styles from "./background.module.css";

export default function BackgroundPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link aria-label="返回 Artifact Agent 首页" className={styles.backLink} href="/zh">
            <ArrowLeftIcon aria-hidden="true" />
            <span>Artifact Agent</span>
          </Link>
        </div>
      </header>
      <main className={styles.main} id="main-content" />
    </div>
  );
}

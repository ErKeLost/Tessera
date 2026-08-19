"use client";

import { Card, type CardProps } from "fumadocs-ui/components/card";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { localizedPath } from "@/lib/i18n";

export function LocalizedCard({ href, ...props }: CardProps) {
  const { locale = "en" } = useI18n();
  const localizedHref = href?.startsWith("/docs") ? localizedPath(locale, href) : href;

  return <Card href={localizedHref} {...props} />;
}

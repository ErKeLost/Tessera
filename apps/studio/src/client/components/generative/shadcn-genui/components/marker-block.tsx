"use client";

import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { defineComponent } from "@openuidev/react-lang";
import {
  Calendar,
  Check,
  CircleAlert,
  Clock,
  Database,
  FileText,
  Info,
  LoaderCircle,
  TriangleAlert,
  User,
} from "lucide-react";
import type { ComponentType } from "react";
import { z } from "zod";

/** The icon vocabulary the model may pick from, so answers stay on-system. */
const MARKER_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  info: Info,
  success: Check,
  warning: TriangleAlert,
  error: CircleAlert,
  loading: LoaderCircle,
  file: FileText,
  calendar: Calendar,
  user: User,
  database: Database,
  clock: Clock,
};

const MarkerBlockSchema = z.object({
  text: z.string(),
  variant: z.enum(["default", "separator", "border"]).optional(),
  icon: z
    .enum([
      "info",
      "success",
      "warning",
      "error",
      "loading",
      "file",
      "calendar",
      "user",
      "database",
      "clock",
    ])
    .optional(),
});

export const MarkerBlock = defineComponent({
  name: "MarkerBlock",
  props: MarkerBlockSchema,
  description:
    'One status line with an optional icon — for progress notes, section dividers and timestamps inside an answer. variant: "default" (plain line), "separator" (label centred between rules), "border" (line above a bottom rule). icon: "info" | "success" | "warning" | "error" | "loading" | "file" | "calendar" | "user" | "database" | "clock".',
  component: ({ props }) => {
    const Icon = props.icon ? MARKER_ICONS[props.icon] : undefined;

    return (
      <Marker variant={props.variant ?? "default"}>
        {Icon && (
          <MarkerIcon>
            <Icon className={props.icon === "loading" ? "animate-spin" : undefined} />
          </MarkerIcon>
        )}
        <MarkerContent>{props.text}</MarkerContent>
      </Marker>
    );
  },
});

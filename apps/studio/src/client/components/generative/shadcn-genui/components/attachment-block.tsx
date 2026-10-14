"use client";

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { defineComponent } from "@openuidev/react-lang";
import { FileCode, FileSpreadsheet, FileText, ImageIcon, Table } from "lucide-react";
import type { ComponentType } from "react";
import { z } from "zod";

/** The media icon for each attachment kind. */
const ATTACHMENT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  file: FileText,
  image: ImageIcon,
  table: Table,
  code: FileCode,
  sheet: FileSpreadsheet,
};

const AttachmentBlockSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  kind: z.enum(["file", "image", "table", "code", "sheet"]).optional(),
  state: z.enum(["idle", "uploading", "processing", "error", "done"]).optional(),
});

export const AttachmentBlock = defineComponent({
  name: "AttachmentBlock",
  props: AttachmentBlockSchema,
  description:
    'Card for one file, image or artifact the answer refers to. name: file name or label, description: size/status detail. kind: "file" | "image" | "table" | "code" | "sheet" (picks the icon). state: "idle" | "uploading" | "processing" | "error" | "done" (defaults to done; processing/uploading add a shimmer, error turns it red).',
  component: ({ props }) => {
    const Icon = ATTACHMENT_ICONS[props.kind ?? "file"] ?? FileText;

    return (
      <Attachment
        state={props.state ?? "done"}
        size="sm"
        orientation="horizontal"
        className="w-full max-w-md"
      >
        <AttachmentMedia variant={props.kind === "image" ? "image" : "icon"}>
          <Icon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{props.name}</AttachmentTitle>
          {props.description && (
            <AttachmentDescription>{props.description}</AttachmentDescription>
          )}
        </AttachmentContent>
      </Attachment>
    );
  },
});

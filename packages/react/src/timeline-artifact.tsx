"use client";

import type { TimelineArtifact as TimelineArtifactData } from "@data-elements/schema";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  Clock3Icon,
  InfoIcon,
  TimelineIcon,
} from "lucide-react";
import { useArtifactAction } from "./bridge";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

const eventStyles = {
  planned: {
    icon: Clock3Icon,
    label: "Planned",
    className: "text-muted-foreground",
  },
  "in-progress": {
    icon: CircleDotIcon,
    label: "In progress",
    className: "de-warning",
  },
  completed: {
    icon: CircleCheckIcon,
    label: "Completed",
    className: "de-positive",
  },
  blocked: { icon: CircleXIcon, label: "Blocked", className: "de-negative" },
  info: { icon: InfoIcon, label: "Info", className: "text-foreground" },
} as const;

function resolveTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

function formatEventDate(
  value: string,
  locale: string,
  timeZone: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));
  }
}

export function TimelineArtifact({
  artifact,
  locale = "en-US",
}: {
  artifact: TimelineArtifactData;
  locale?: string;
}) {
  const emit = useArtifactAction(artifact);
  const timeZone = resolveTimeZone(artifact.timeZone);
  const events = [...artifact.events].sort((left, right) => {
    const difference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return artifact.order === "ascending" ? difference : -difference;
  });

  return (
    <Artifact className="de-timeline-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={TimelineIcon}>
              {events.length.toLocaleString(locale)}{" "}
              {events.length === 1 ? "event" : "events"}
            </ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent>
        <ol className="de-timeline-list">
          {events.map((event, index) => {
            const style = eventStyles[event.status];
            const Icon = style.icon;
            const first = index === 0;
            const last = index === events.length - 1;
            return (
              <li className="relative" key={event.id}>
                {events.length > 1 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "de-timeline-track absolute z-0 w-px -translate-x-1/2 bg-border",
                      first
                        ? "de-timeline-track-first"
                        : last
                          ? "de-timeline-track-last"
                          : "de-timeline-track-middle",
                    )}
                  />
                )}
                <button
                  className="de-quiet-button de-timeline-row de-list-row group grid w-full touch-manipulation grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:grid-cols-[8rem_1.5rem_minmax(0,1fr)] sm:px-4"
                  onClick={() =>
                    void emit("timeline-item-select", { eventId: event.id })
                  }
                  type="button"
                >
                  <time
                    className="de-metadata col-start-2 row-start-1 leading-4 sm:col-start-1 sm:text-right"
                    dateTime={event.timestamp}
                  >
                    {formatEventDate(event.timestamp, locale, timeZone)}
                  </time>
                  <span className="relative col-start-1 row-start-1 row-span-2 flex h-full min-h-12 justify-center sm:col-start-2">
                    <span
                      className={cn(
                        "relative z-[1] grid size-6 place-items-center border border-border bg-card",
                        shape.full,
                        style.className,
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3" />
                    </span>
                  </span>
                  <span className="col-start-2 row-start-2 min-w-0 pt-1 sm:col-start-3 sm:row-start-1 sm:row-span-2 sm:pt-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="text-[13.5px] font-medium">
                        {event.label}
                      </strong>
                      <span className={cn("de-metadata", style.className)}>
                        {style.label}
                      </span>
                    </span>
                    <span className="mt-1.5 block text-[13px] leading-5 text-pretty text-muted-foreground">
                      {event.description}
                    </span>
                    {event.actor && (
                      <span className="de-metadata mt-2 block">
                        {event.actor}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="de-field flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] tracking-tight text-muted-foreground sm:px-4">
          <span>
            {artifact.order === "ascending" ? "Oldest first" : "Newest first"}
          </span>
          <span className="font-mono">{timeZone}</span>
        </div>
      </ArtifactContent>
    </Artifact>
  );
}

import { parsePreviewDescriptor } from "@/components/generative-gallery-model";
import { createGenerativeGalleryEvent } from "@/lib/generative-gallery-proof";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const descriptor = parsePreviewDescriptor(
      url.searchParams.get("kind"),
      url.searchParams.get("value"),
    );
    const filter = url.searchParams.get("filter");
    if (filter !== null && filter !== "north" && filter !== "south") {
      return NextResponse.json(
        { error: "Unknown filter value." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const event = await createGenerativeGalleryEvent(
      descriptor,
      filter === null ? {} : { filterValue: filter },
    );
    return NextResponse.json(event, { headers: noStoreHeaders() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create proof surface." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
  };
}

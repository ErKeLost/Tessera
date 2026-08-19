import { createBackgroundPostHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = createBackgroundPostHandler();

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9-]+\.json$/.test(name)) {
    return NextResponse.json({ error: "Invalid registry item." }, { status: 400 });
  }

  return NextResponse.json(
    {
      error: "The Tessera Agent component registry is not published. Use the repository source and proof workflow.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function getBuildRevision() {
  const revision = process.env.GITHUB_SHA
    ?? process.env.COMMIT_REF
    ?? process.env.VERCEL_GIT_COMMIT_SHA;

  return revision && /^[a-f0-9]{7,64}$/i.test(revision) ? revision : "unknown";
}

function healthPayload() {
  return {
    status: "ok",
    service: "artifact-ui",
    readiness: "ready",
    revision: getBuildRevision(),
    checks: { application: "pass" },
  };
}

export function GET() {
  return Response.json(healthPayload(), { headers: responseHeaders });
}

export function HEAD() {
  return new Response(null, { headers: responseHeaders });
}

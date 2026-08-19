import { BackgroundSecurity, backgroundSecurity } from "@/lib/background-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 5;

const MAX_ACCESS_BODY_BYTES = 2 * 1024;

export function createBackgroundAccessPostHandler(security: BackgroundSecurity = backgroundSecurity) {
  return async function postBackgroundAccess(request: Request): Promise<Response> {
    try {
      const accessToken = await readAccessToken(request);
      const grant = security.issueSession(request, accessToken);
      if (!grant.success) return accessError(grant.status, grant.code, grant.message);
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": grant.cookie,
          Vary: "Origin",
        },
      });
    } catch (error) {
      if (error instanceof AccessRequestError) {
        return accessError(error.status, error.code, error.message);
      }
      return accessError(400, "background_access_invalid_request", "The access request is invalid.");
    }
  };
}

export const POST = createBackgroundAccessPostHandler();

async function readAccessToken(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new AccessRequestError(415, "background_access_unsupported_media_type", "The access request must use application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACCESS_BODY_BYTES) throw tooLarge();
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_ACCESS_BODY_BYTES) throw tooLarge();
  try {
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidAccessRequest();
    const token = (payload as { accessToken?: unknown }).accessToken;
    if (typeof token !== "string" || token.trim().length === 0 || token.length > 1_024) throw invalidAccessRequest();
    return token;
  } catch (error) {
    if (error instanceof AccessRequestError) throw error;
    throw invalidAccessRequest();
  }
}

function accessError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
  );
}

function invalidAccessRequest(): AccessRequestError {
  return new AccessRequestError(400, "background_access_invalid_request", "The access request is invalid.");
}

function tooLarge(): AccessRequestError {
  return new AccessRequestError(413, "background_access_request_too_large", "The access request is too large.");
}

class AccessRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

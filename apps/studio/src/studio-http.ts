import { H3, getRouterParam, type H3Event, type HTTPError } from "h3";

export type StudioHttpStatus = number;

type StudioContextValues = Record<string, unknown>;

export class StudioHttpContext<Values extends StudioContextValues> {
  readonly #event: H3Event;

  constructor(event: H3Event) {
    this.#event = event;
  }

  get req(): Readonly<{
    raw: Request;
    method: string;
    url: string;
    path: string;
    header(name: string): string | undefined;
    param(name: string): string | undefined;
    query(): Record<string, string>;
    query(name: string): string | undefined;
  }> {
    const event = this.#event;
    return {
      raw: event.req,
      method: event.req.method,
      url: event.req.url,
      path: event.url.pathname,
      header: (name) => event.req.headers.get(name) ?? undefined,
      param: (name) => getRouterParam(event, name, { decode: true }),
      query: ((name?: string) => (
        name === undefined
          ? Object.fromEntries(event.url.searchParams.entries())
          : event.url.searchParams.get(name) ?? undefined
      )) as {
        (): Record<string, string>;
        (name: string): string | undefined;
      },
    };
  }

  get res(): Readonly<{ status: number }> {
    return { status: this.#event.res.status ?? 200 };
  }

  get<K extends keyof Values & string>(key: K): Values[K] {
    return this.#event.context[key] as Values[K];
  }

  set<K extends keyof Values & string>(key: K, value: Values[K]): void {
    this.#event.context[key] = value;
  }

  header(name: string, value: string): void {
    this.#event.res.headers.set(name, value);
  }

  json(value: unknown, status: StudioHttpStatus = 200): Response {
    this.#event.res.status = status;
    const headers = new Headers(this.#event.res.headers);
    headers.set("Content-Type", "application/json; charset=UTF-8");
    return new Response(JSON.stringify(value), { headers, status });
  }

  body(value: BodyInit | null, status: StudioHttpStatus = 200): Response {
    this.#event.res.status = status;
    return new Response(value, { headers: new Headers(this.#event.res.headers), status });
  }
}

type StudioHandler<Values extends StudioContextValues> = (
  context: StudioHttpContext<Values>,
) => unknown | Promise<unknown>;

type StudioMiddleware<Values extends StudioContextValues> = (
  context: StudioHttpContext<Values>,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export class StudioHttpApp<Values extends StudioContextValues> {
  readonly #app: H3;
  #errorHandler?: (error: unknown, context: StudioHttpContext<Values>) => unknown | Promise<unknown>;

  constructor() {
    this.#app = new H3({
      onError: (error, event) => this.#errorHandler?.(unwrapHttpError(error), new StudioHttpContext<Values>(event)),
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.#app.fetch(request);
  }

  use(route: string, middleware: StudioMiddleware<Values>): this;
  use(middleware: StudioMiddleware<Values>): this;
  use(
    routeOrMiddleware: string | StudioMiddleware<Values>,
    maybeMiddleware?: StudioMiddleware<Values>,
  ): this {
    const route = typeof routeOrMiddleware === "string" ? normalizeWildcard(routeOrMiddleware) : undefined;
    const middleware = typeof routeOrMiddleware === "string" ? maybeMiddleware : routeOrMiddleware;
    if (!middleware) throw new TypeError("Studio middleware is required.");
    const handler = (event: H3Event, next: () => unknown | Promise<unknown>) => (
      middleware(new StudioHttpContext<Values>(event), next)
    );
    if (route === undefined) this.#app.use(handler);
    else this.#app.use(route, handler);
    return this;
  }

  get(route: string, handler: StudioHandler<Values>): this {
    this.#app.get(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  post(route: string, handler: StudioHandler<Values>): this {
    this.#app.post(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  put(route: string, handler: StudioHandler<Values>): this {
    this.#app.put(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  patch(route: string, handler: StudioHandler<Values>): this {
    this.#app.patch(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  delete(route: string, handler: StudioHandler<Values>): this {
    this.#app.delete(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  options(route: string, handler: StudioHandler<Values>): this {
    this.#app.options(normalizeWildcard(route), wrapHandler(handler));
    return this;
  }

  notFound(handler: StudioHandler<Values>): this {
    this.#app.all("/**", wrapHandler(handler));
    return this;
  }

  onError(handler: (error: unknown, context: StudioHttpContext<Values>) => unknown | Promise<unknown>): this {
    this.#errorHandler = handler;
    return this;
  }
}

function wrapHandler<Values extends StudioContextValues>(handler: StudioHandler<Values>) {
  return (event: H3Event) => handler(new StudioHttpContext<Values>(event));
}

function normalizeWildcard(route: string): string {
  if (route === "*") return "/**";
  return route.endsWith("/*") ? `${route}*` : route;
}

function unwrapHttpError(error: HTTPError): unknown {
  return error.cause instanceof Error ? error.cause : error;
}

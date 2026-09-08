# `@open-tessera/agent`

Server-only Mastra orchestration for Tessera's governed data agent.

The package owns the model prompt, request context, tool contracts, execution
loop, evidence projection, and public
stream filtering. It accepts narrow host ports for identity, persistence,
database mutation approval, continual learning, and public error mapping.

It does not read environment variables, open a database connection, create an
HTTP server, persist browser transcripts, or manage client UI state.
Those responsibilities belong to the embedding host.

Analysis preparation remains retryable after invalid input, compilation failure,
or successful execution. Each preparation issues a new execution reference;
references themselves remain single-use. Catalog binding checks the identifiers
actually used by the plan, without requiring every search candidate to participate.
Result normalization and tool diagnostics do not filter SQL, credential-shaped
text, or field names. Host error formatters remain an explicit integration option.

## Database Permissions

The host supplies `permissionContext`; execution checks do not depend on the
model following its prompt. `read-only` disables mutations while permitting
queries when `sqlStatements.read` is `allow`. Missing authorization and denied
reads are blocked before data access. Read approval is not implemented: hosts
should expose only `allow` and `deny` for reads. A legacy `read: "ask"` fails
closed with `read_approval_unsupported` and is projected as denied to the model.

Mutation classification uses `@open-tessera/database`: inserts are `write`;
updates, deletes, and DDL are `destructive`. The Agent enforces access-mode and
class-level denial limits, including on resume. The host mutation port evaluates
the concrete action, scopes, rules, and approval grants before execution.
`submit` no longer unconditionally requests approval: an allowed action can run
immediately, while an action requiring review produces a host checkpoint.
Mastra's `suspend` / `resumeStream` carries that review through the Agent loop.
Approval must still be bound and revalidated by the host; it is not a permission
grant supplied by the model.

With the default `normal` profile, mutations still require approval. Under `auto`,
inserts may execute automatically; updates remain subject to destructive-operation
policy. Under `dangerous`, mutations may execute automatically if the remaining
host checks permit them. Studio rejects `read: "ask"` in configuration and settings.

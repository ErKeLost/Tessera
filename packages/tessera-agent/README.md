# `@open-tessera/agent`

Server-only Mastra orchestration for Tessera's governed data agent.

The package owns the model prompt, request context, tool contracts, execution
loop, evidence projection, and public
stream filtering. It accepts narrow host ports for identity, persistence,
database mutation approval, continual learning, and public error mapping.

It does not read environment variables, open a database connection, create an
HTTP server, persist browser transcripts, or manage client UI state.
Those responsibilities belong to the embedding host.

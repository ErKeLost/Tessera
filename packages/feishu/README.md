# `@open-tessera/feishu`

Server-only Feishu OAuth helpers and a permission-preserving document reader.
The reader accepts a host-owned user access token provider; it never stores or
exposes app secrets and does not widen the principal's Feishu permissions.

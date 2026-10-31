import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PostgresStore } from "@mastra/pg";
import { POSTGRES_DURABLE_STATE_MIGRATION, PostgresDurableStateStore, type DurableStateStorePort } from "@open-tessera/runtime";
import { createUnconfiguredTesseraConfig } from "./config";
import { createStudioApp, type StudioIdentity } from "./server";
import { createDefaultTesseraStudioRuntimeFactory, createTesseraStudioRuntimeManager, type TesseraStudioSettingsCandidate, type TesseraStudioSettingsStore } from "./settings-runtime";
import { createTesseraSessionMemory } from "./session-memory";
import { FeishuConnectionService } from "./feishu-connections";

let backend: Promise<{ storage: PostgresStore; state: DurableStateStorePort }> | undefined;

async function getBackend() {
  backend ??= (async () => {
    const connectionString = process.env.TESSERA_STORAGE_DATABASE_URL ?? process.env.NETLIFY_DB_URL;
    if (!connectionString) throw new Error("Cloud PostgreSQL storage is not configured.");
    const storage = new PostgresStore({ id: "tessera-cloud", connectionString, max: 4 });
    try {
      await storage.init();
      await storage.pool.query(POSTGRES_DURABLE_STATE_MIGRATION);
    } catch (error) {
      await storage.close().catch(() => undefined);
      throw error;
    }
    const state = new PostgresDurableStateStore({
      transaction: async (operation) => {
        const client = await storage.pool.connect();
        try {
          await client.query("BEGIN");
          const result = await operation({ query: (sql, parameters) => client.query(sql, parameters ? [...parameters] : []) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      },
    });
    return { storage, state };
  })().catch((error) => { backend = undefined; throw error; });
  return backend;
}

export async function createCloudStudioRequest(request: Request, secret: string) {
  const { storage, state } = await getBackend();
  const config = createUnconfiguredTesseraConfig();
  const feishuConnections = new FeishuConnectionService({ state, encryptionSecret: secret });
  const settingsRuntime = await createTesseraStudioRuntimeManager({
    config,
    initiallyUnconfigured: true,
    databaseState: state,
    store: createEncryptedCloudSettingsStore(state, secret),
    factory: createDefaultTesseraStudioRuntimeFactory({
      feishuConnections,
      createSessionMemory: () => createTesseraSessionMemory({ storage, closeStorage: false }),
    }),
  });
  const lease = settingsRuntime.acquire();
  const identity: StudioIdentity = { tenantId: "cloud-workspace", subject: "workspace-owner", roles: ["admin"] };
  const app = createStudioApp({
    connector: lease.runtime.connector,
    settingsRuntime,
    authenticate: () => identity,
    requireAuthentication: true,
    feishuConnections,
    authorizeSettingsChange: () => true,
  });
  await lease.release();
  try {
    const response = await app.fetch(request);
    if (!response.body) { await settingsRuntime.close(); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { await settingsRuntime.close(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { await settingsRuntime.close(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await settingsRuntime.close(); } },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { await settingsRuntime.close(); throw error; }
}

export function createEncryptedCloudSettingsStore(state: DurableStateStorePort, secret: string): TesseraStudioSettingsStore {
  const key = "tessera.cloud.settings";
  const encryptionKey = createHash("sha256").update(`tessera-settings:${secret}`).digest();
  return {
    async read() {
      const record = await state.read<{ iv: string; tag: string; data: string }>(key);
      if (!record) return undefined;
      const cipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(record.iv, "base64"));
      cipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.data, "base64")), cipher.final()]).toString("utf8")) as TesseraStudioSettingsCandidate;
    },
    async write(candidate) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(candidate), "utf8"), cipher.final()]);
      await state.transaction([key], (tx) => tx.set(key, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }));
    },
    async clear() { await state.transaction([key], (tx) => tx.delete(key)); },
  };
}

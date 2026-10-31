import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore } from "@open-tessera/runtime";
import { createEncryptedCloudSettingsStore } from "./cloud-runtime";
import type { TesseraStudioSettingsCandidate } from "./settings-runtime";

describe("cloud settings persistence", () => {
  test("restores encrypted settings through a new store and rejects the wrong key", async () => {
    const state = new InMemoryDurableStateStore();
    const settings: TesseraStudioSettingsCandidate = {
      database: { dialect: "postgres", accessMode: "read-only", url: "postgresql://reader:test-password@localhost/data" },
      llm: { provider: "openrouter", model: "test/model", reasoningEffort: "default", apiKey: "test-provider-secret" },
      limits: { maxRows: 100, timeoutMs: 1_000, maxSteps: 5 },
    };
    await createEncryptedCloudSettingsStore(state, "test-workspace-key").write(settings);
    const stored = JSON.stringify(await state.read("tessera.cloud.settings"));
    expect(stored).not.toContain("test-provider-secret");
    expect(stored).not.toContain("test-password");
    const reopened = createEncryptedCloudSettingsStore(state, "test-workspace-key");
    expect(await reopened.read()).toEqual(settings);
    await expect(createEncryptedCloudSettingsStore(state, "wrong-key").read()).rejects.toThrow();
    await reopened.clear?.();
    expect(await reopened.read()).toBeUndefined();
  });
});

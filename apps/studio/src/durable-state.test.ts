import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTesseraDurableStateStore } from "./durable-state";

const temporaryDirectories: string[] = [];

type GrantState = {
  version: number;
  operations: string[];
};

type ActionState = {
  status: string;
  effects?: number;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "tessera-durable-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Tessera Studio durable action state", () => {
  test("persists committed JSON across restarts and rolls back a whole declared-key transaction", async () => {
    const rootDirectory = temporaryRoot();
    const first = createTesseraDurableStateStore({ rootDirectory });

    await first.state.transaction(["grant:tenant-a", "action:run-1"], async (transaction) => {
      await transaction.set("grant:tenant-a", { version: 1, operations: ["data.update"] });
      await transaction.set("action:run-1", { status: "awaiting-approval" });
    });
    await first.close();

    const restarted = createTesseraDurableStateStore({ rootDirectory });
    expect(await restarted.state.read<GrantState>("grant:tenant-a")).toEqual({ version: 1, operations: ["data.update"] });
    expect(await restarted.state.read<ActionState>("action:run-1")).toEqual({ status: "awaiting-approval" });

    await expect(restarted.state.transaction(["grant:tenant-a", "action:run-1"], async (transaction) => {
      await transaction.set("grant:tenant-a", { version: 2, operations: ["data.delete"] });
      await transaction.delete("action:run-1");
      throw new Error("declined");
    })).rejects.toThrow("declined");

    expect(await restarted.state.read<GrantState>("grant:tenant-a")).toEqual({ version: 1, operations: ["data.update"] });
    expect(await restarted.state.read<ActionState>("action:run-1")).toEqual({ status: "awaiting-approval" });

    await restarted.state.transaction(["action:run-1"], async (transaction) => {
      expect(await transaction.get<ActionState>("action:run-1")).toEqual({ status: "awaiting-approval" });
      await transaction.set("action:run-1", { status: "completed", effects: 1 });
    });
    await restarted.close();

    const later = createTesseraDurableStateStore({ rootDirectory });
    expect(await later.state.read<ActionState>("action:run-1")).toEqual({ status: "completed", effects: 1 });
    await later.close();
  });
});

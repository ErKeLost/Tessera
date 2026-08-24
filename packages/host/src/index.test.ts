import { expect, test } from "bun:test";
import {
  actorAuditRefSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
} from "@open-generative/protocol";
import { chartRecipes } from "@open-generative/components";
import { createOpenGenerativeHost } from "./index";

test("prepares a static UI turn without domain resources", async () => {
  const host = await createOpenGenerativeHost();
  const turn = await host.prepareTurn({
    authority: {
      actorAuditRef: actorAuditRefSchema.parse("actor:static-test"),
      actorBindingHash: sha256HashSchema.parse(`sha256:${"c".repeat(64)}`),
      tenantBindingHash: sha256HashSchema.parse(`sha256:${"d".repeat(64)}`),
      authorityPolicyRevision: "test:1",
    },
    resources: [],
  });

  expect(turn).toBeDefined();
  expect(turn?.catalogSlice.resources).toEqual([]);
  expect(turn?.language.id).toBe("open-generative-language/1");
  expect(turn?.language.systemPrompt).toContain("Output only OGL assignment statements");
});

test("compiles a governed data turn and publishes the model-composed Surface", async () => {
  const host = await createOpenGenerativeHost();
  const turn = await host.prepareTurn({
    authority: {
      actorAuditRef: actorAuditRefSchema.parse("actor:test"),
      actorBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
      tenantBindingHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
      authorityPolicyRevision: "test:1",
    },
    presentationPolicy: "required",
    resources: [{
      bindingId: "analysis-result",
      label: "Visitors by device",
      dataset: resourceDatasetPayloadSchema.parse({
        columns: [
          { columnId: "device", label: "Device", valueType: "string" },
          { columnId: "visitors", label: "Visitors", valueType: "number" },
        ],
        rows: [
          { device: "Desktop", visitors: 610 },
          { device: "Mobile", visitors: 390 },
        ],
        totalRows: 2,
        hasMore: false,
      }),
    }],
  });
  expect(turn).toBeDefined();
  const requiredTurn = turn!;
  expect(requiredTurn.language.resources[0]?.alias).toBe("data1");
  expect(requiredTurn.language.systemPrompt).toContain("must contain at least one Metric or Chart");
  const recipeBlock = requiredTurn.language.systemPrompt
    .split("Chart recipe catalog (each line is one exact recipe ID and its model-supplied required props):")[1]
    ?.split("Catalog components:")[0];
  expect(recipeBlock).toBeDefined();
  expect(recipeBlock?.match(/\"recipe\":/g)).toHaveLength(17);
  for (const recipe of chartRecipes) {
    expect(recipeBlock).toContain(`\"recipe\":\"${recipe}\"`);
  }
  expect(recipeBlock).not.toContain('\"recipe\":\"bars\"');
  expect(requiredTurn.language.systemPrompt).toContain("exact closed enum");

  const session = await requiredTurn.createSession();
  await session.pushTextDelta('root = Report("Device visitors", "Verified result", content)\n');
  expect(requiredTurn.drainEvents()).toEqual([]);
  await session.pushTextDelta('content = Stack("md", [visitors])\n');
  const initialEvents = requiredTurn.drainEvents();
  expect(initialEvents[0]?.payload.type).toBe("snapshot-published");
  expect(initialEvents.some((event) => event.payload.type === "preview-applied")).toBe(true);
  await session.pushTextDelta('visitors = Metric("Total visitors", @data1, "visitors", "number")\n');
  const outcome = await session.finish();

  expect(outcome.status).toBe("committed");
  const events = [...initialEvents, ...requiredTurn.drainEvents()];
  expect(events.at(-1)?.payload.type).toBe("revision-committed");
  await expect(requiredTurn.createSession()).rejects.toThrow(
    "already committed a Surface revision",
  );
  if (events[0]?.payload.type !== "snapshot-published") throw new Error("Expected a Surface snapshot.");
  expect(Object.keys(events[0].payload.snapshot.resources)).toHaveLength(1);
}, { timeout: 30_000 });

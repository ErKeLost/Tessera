import { expect, test } from "bun:test";
import {
  actorAuditRefSchema,
  authoringSnapshotProposalSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
} from "@open-generative/protocol";
import { createOpenGenerativeHost } from "./index";

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
  const componentId = (type: string) => requiredTurn.catalogSlice.components
    .find((entry) => entry.contract.componentType === type)?.sliceComponentId;
  const resourceId = requiredTurn.catalogSlice.resources[0]?.sliceResourceId;
  expect(componentId("analysis.report")).toBeDefined();
  expect(componentId("layout.stack")).toBeDefined();
  expect(componentId("data.metric")).toBeDefined();
  expect(resourceId).toBeDefined();
  expect(requiredTurn.compiled.systemPrompt).toContain("must be presented");

  const session = await requiredTurn.createSession({ toolCallId: "tool:test" });
  const outcome = await session.complete(authoringSnapshotProposalSchema.parse({
    kind: "snapshot",
    root: {
      localId: "report",
      component: componentId("analysis.report")!,
      props: { title: "Device visitors" },
      slots: {
        body: [{
          localId: "stack",
          component: componentId("layout.stack")!,
          props: { gap: "md" },
          slots: {
            body: [{
              localId: "visitors",
              component: componentId("data.metric")!,
              props: {
                label: "Total visitors",
                data: {
                  ref: "resource",
                  target: { kind: "resource", localId: "analysis-data" },
                },
                valueColumn: "visitors",
                format: "number",
              },
            }],
          },
        }],
      },
    },
    resourceBindings: [{
      localId: "analysis-data",
      value: { source: resourceId! },
    }],
    meta: { title: "Device visitors", tags: [] },
  }));

  expect(outcome.status).toBe("committed");
  const events = requiredTurn.drainEvents();
  expect(events).toHaveLength(1);
  expect(events[0]?.payload.type).toBe("snapshot-published");
  if (events[0]?.payload.type !== "snapshot-published") throw new Error("Expected a Surface snapshot.");
  expect(Object.keys(events[0].payload.snapshot.resources)).toHaveLength(1);
});

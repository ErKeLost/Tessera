import {
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
} from "./constants";
import {
  committedRevisionSchema,
  documentContentSchema,
  hashDocumentContent,
  type CommittedRevision,
  type DocumentContent,
} from "./document";
import { sha256HashSchema } from "./hash";

export function testHash(character = "a") {
  return sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
}

export function createDocumentContent(): DocumentContent {
  return documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [{
        publisher: "open-generative",
        catalogId: "official",
        catalogRevision: "2026-08-22",
        manifestHash: testHash("1"),
      }],
      contractSetHash: testHash("2"),
    },
    requirements: {
      dataClassifications: [],
      evidence: "none",
      placements: [],
      capabilities: [],
    },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: {
          publisher: "open-generative",
          catalogId: "official",
          componentType: "layout.stack",
          revision: 1,
          contractHash: testHash("3"),
        },
        props: {
          gap: { kind: "literal", value: "md" },
        },
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: {},
    evidenceBindings: {},
    claims: {},
    meta: { title: "Test surface", tags: [] },
  });
}

export async function createCommittedRevision(): Promise<CommittedRevision> {
  const content = createDocumentContent();
  return committedRevisionSchema.parse({
    envelope: {
      documentId: "document-test",
      revisionId: "revision-test",
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00Z",
      createdBy: "audit-test",
    },
    content,
  });
}

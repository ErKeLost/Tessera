import { z } from "zod";
import {
  actionTypeSchema,
  catalogIdSchema,
  catalogRevisionSchema,
  componentTypeSchema,
  evidenceIdSchema,
  publisherIdSchema,
  resourceBindingIdSchema,
  signatureRefSchema,
  sliceActionIdSchema,
  sliceComponentIdSchema,
  sliceEvidenceIdSchema,
  sliceResourceIdSchema,
} from "./ids";
import { sha256HashSchema } from "./hash";

export const contractRefSchema = z.object({
  publisher: publisherIdSchema,
  catalogId: catalogIdSchema,
  componentType: componentTypeSchema,
  revision: z.number().int().positive(),
  contractHash: sha256HashSchema,
}).strict();

export const actionContractRefSchema = z.object({
  publisher: publisherIdSchema,
  catalogId: catalogIdSchema,
  actionType: actionTypeSchema,
  revision: z.number().int().positive(),
  contractHash: sha256HashSchema,
}).strict();

export const catalogManifestRefSchema = z.object({
  publisher: publisherIdSchema,
  catalogId: catalogIdSchema,
  catalogRevision: catalogRevisionSchema,
  manifestHash: sha256HashSchema,
  signatureRef: signatureRefSchema.optional(),
}).strict();

export const offeredResourceBindingRefSchema = z.object({
  bindingId: resourceBindingIdSchema,
  offerHash: sha256HashSchema,
}).strict();

export const offeredEvidenceRefSchema = z.object({
  evidenceId: evidenceIdSchema,
  offerHash: sha256HashSchema,
}).strict();

export const catalogSliceComponentSchema = z.object({
  sliceComponentId: sliceComponentIdSchema,
  contract: contractRefSchema,
}).strict();

export const catalogSliceActionSchema = z.object({
  sliceActionId: sliceActionIdSchema,
  contract: actionContractRefSchema,
}).strict();

export const catalogSliceResourceSchema = z.object({
  sliceResourceId: sliceResourceIdSchema,
  source: offeredResourceBindingRefSchema,
}).strict();

export const catalogSliceEvidenceSchema = z.object({
  sliceEvidenceId: sliceEvidenceIdSchema,
  source: offeredEvidenceRefSchema,
}).strict();

export type ContractRef = z.infer<typeof contractRefSchema>;
export type ActionContractRef = z.infer<typeof actionContractRefSchema>;
export type CatalogManifestRef = z.infer<typeof catalogManifestRefSchema>;
export type OfferedResourceBindingRef = z.infer<typeof offeredResourceBindingRefSchema>;
export type OfferedEvidenceRef = z.infer<typeof offeredEvidenceRefSchema>;
export type CatalogSliceComponent = z.infer<typeof catalogSliceComponentSchema>;
export type CatalogSliceAction = z.infer<typeof catalogSliceActionSchema>;
export type CatalogSliceResource = z.infer<typeof catalogSliceResourceSchema>;
export type CatalogSliceEvidence = z.infer<typeof catalogSliceEvidenceSchema>;

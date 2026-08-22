export {
  CompilerCatalog,
  createCompilerCatalog,
  defaultCompilerCatalog,
  defineNodeContract,
  semanticArtifactContracts,
  sliceCatalog,
  surfaceNodeContracts,
  type CatalogSliceInput,
} from "./catalog";
export {
  CompilerDiagnosticError,
  compilerDiagnostic,
  diagnosticsFromUnknown,
} from "./diagnostics";
export {
  ArtifactCommitError,
  commitValidatedArtifactProposal,
  defaultArtifactIdFactory,
  materializeArtifactPart,
  mergeArtifactCommitHostContext,
  toArtifactPartWire,
  type ArtifactCommitHostContext,
  type ArtifactCommitIdKind,
  type ArtifactCommitOptions,
  type ArtifactUIHostContext,
  type ArtifactUIIdKind,
  type MaterializeArtifactPartOptions,
} from "./commit";
export {
  computeDocumentPolicyHash,
  createDocumentPolicy,
  DEFAULT_DOCUMENT_POLICY,
  joinInformationFlow,
  prepareInformationFlow,
  type DocumentPolicyInput,
  type PreparedInformationFlow,
} from "./information-flow";
export {
  DEFAULT_GENERATION_LIMITS,
  normalizeSurface,
  resolveGenerationLimits,
  safeNormalizeSurface,
  type NormalizeSurfaceOptions,
} from "./normalize";
export { isArtifactPart } from "./part";
export {
  compilePrompt,
  compilerSchemaProfile,
  createProviderSchema,
  type PromptCompileInput,
} from "./prompt";
export {
  runBoundedRepair,
  sanitizeRepairDiagnostics,
  type BoundedRepairOptions,
} from "./repair";
export {
  condition,
  defineSurface,
  projectArtifactToNodeProps,
  reference,
  surface,
} from "./surface";
export {
  createArtifactCompiler,
  prepareTurn,
  type AcceptArtifactOptions,
  type ArtifactCompilerOptions,
  type LabeledDocumentSummary,
  type PreparedTurn,
  type PrepareTurnInput,
  type TurnMessage,
} from "./turn";
export type * from "./types";

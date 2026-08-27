import type {
  OpenGenerativeAuthority,
  OpenGenerativeInspectionRecord,
} from "@open-generative/mastra";

export type { OpenGenerativeInspectionRecord } from "@open-generative/mastra";

/**
 * Server-only read boundary for Host Inspector snapshots. Implementations must
 * authorize the Host-derived authority and never accept browser-provided scope.
 */
export type TesseraOpenGenerativeInspectionReader = Readonly<{
  read(input: Readonly<{
    surfaceSessionId: string;
    authority: OpenGenerativeAuthority;
  }>):
    | OpenGenerativeInspectionRecord
    | undefined
    | Promise<OpenGenerativeInspectionRecord | undefined>;
}>;

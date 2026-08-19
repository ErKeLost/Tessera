import { canonicalize } from "./canonical";
import { BOOTSTRAP_PROTOCOL, DEFAULT_PROTOCOL_LIMITS } from "./constants";
import type {
  BootstrapHello,
  BootstrapResponse,
  CatalogCompatibilityManifest,
  CompatibilitySelection,
  ProtocolLimits,
} from "./schemas";

export type CompatibilitySupport = {
  documentProtocolVersions: string[];
  streamProtocolVersions: string[];
  codecs: { id: string; versions: string[] }[];
  runtimeApiVersions: string[];
  rendererApiVersions: string[];
  features: string[];
  catalogManifests: CatalogCompatibilityManifest[];
  limitCeilings?: ProtocolLimits;
  minimumLimits?: Partial<ProtocolLimits>;
};

export type CompatibilityNegotiationOptions = {
  streamId: string;
  satisfies?: (version: string, range: string) => boolean;
};

export function negotiateBootstrap(
  hello: BootstrapHello,
  support: CompatibilitySupport,
  options: CompatibilityNegotiationOptions,
): BootstrapResponse {
  const satisfies = options.satisfies ?? versionSatisfies;
  const reasons: { code: string; message: string }[] = [];
  const documentProtocol = selectVersion(support.documentProtocolVersions, hello.offer.documentProtocolRanges, satisfies);
  const streamProtocol = selectVersion(support.streamProtocolVersions, hello.offer.streamProtocolRanges, satisfies);
  if (!documentProtocol) reasons.push(reason("document-protocol", "No document protocol version intersects."));
  if (!streamProtocol) reasons.push(reason("stream-protocol", "No stream protocol version intersects."));

  const codec = selectCodec(hello.offer.codecs, support.codecs);
  if (!codec) reasons.push(reason("codec", "No authoring codec version intersects."));

  const unsupportedFeatures = hello.offer.requiredFeatures.filter((feature) => !support.features.includes(feature));
  if (unsupportedFeatures.length > 0) {
    reasons.push(reason("required-feature", `Unsupported required features: ${unsupportedFeatures.join(", ")}.`));
  }

  const offeredManifests = new Map(
    hello.offer.catalogManifests.map((manifest) => [manifest.catalogReleaseId, manifest]),
  );
  const catalogManifest = support.catalogManifests.find((manifest) => {
    const offered = offeredManifests.get(manifest.catalogReleaseId);
    return offered !== undefined && canonicalize(offered) === canonicalize(manifest);
  });
  if (!catalogManifest) reasons.push(reason("catalog-manifest", "No byte-identical supported catalog manifest intersects."));

  const runtimeApiVersion = catalogManifest
    ? support.runtimeApiVersions.find((version) =>
        hello.offer.runtimeApiRanges.some((range) => satisfies(version, range))
        && satisfies(version, catalogManifest.runtimeApiRange)
      )
    : undefined;
  const rendererApiVersion = catalogManifest
    ? support.rendererApiVersions.find((version) =>
        hello.offer.rendererApiRanges.some((range) => satisfies(version, range))
        && satisfies(version, catalogManifest.rendererApiRange)
      )
    : undefined;
  if (!runtimeApiVersion) reasons.push(reason("runtime-api", "No runtime API version intersects the selected manifest."));
  if (!rendererApiVersion) reasons.push(reason("renderer-api", "No renderer API version intersects the selected manifest."));

  const limits = intersectLimits(hello.offer.limits, support.limitCeilings ?? DEFAULT_PROTOCOL_LIMITS);
  for (const [name, minimum] of Object.entries(support.minimumLimits ?? {})) {
    const selected = limits[name as keyof ProtocolLimits];
    if (minimum !== undefined && selected < minimum) {
      reasons.push(reason("resource-limit", `${name} is ${selected}; the runtime requires at least ${minimum}.`));
    }
  }

  if (
    reasons.length > 0
    || !documentProtocol
    || !streamProtocol
    || !codec
    || !catalogManifest
    || !runtimeApiVersion
    || !rendererApiVersion
  ) {
    return {
      bootstrapProtocol: BOOTSTRAP_PROTOCOL,
      type: "incompatible",
      requestId: hello.requestId,
      reasons,
    };
  }

  const selection: CompatibilitySelection = {
    documentProtocol,
    streamProtocol,
    codec,
    runtimeApiVersion,
    rendererApiVersion,
    enabledFeatures: [
      ...hello.offer.requiredFeatures,
      ...hello.offer.optionalFeatures.filter((feature) => support.features.includes(feature)),
    ],
    catalogManifest,
    limits,
  };
  return {
    bootstrapProtocol: BOOTSTRAP_PROTOCOL,
    type: "ready",
    requestId: hello.requestId,
    streamId: options.streamId,
    selection,
  };
}

export function versionSatisfies(version: string, range: string): boolean {
  const alternatives = range.split("||").map((part) => part.trim()).filter(Boolean);
  return alternatives.some((alternative) => satisfiesAlternative(version, alternative));
}

function satisfiesAlternative(version: string, range: string): boolean {
  if (range === "*" || range.toLowerCase() === "latest") return true;
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return version === range;

  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(range);
  if (hyphen) {
    const lower = parseVersion(hyphen[1]!);
    const upper = parseVersion(hyphen[2]!);
    return lower !== undefined && upper !== undefined
      && compareVersion(parsedVersion, lower) >= 0
      && compareVersion(parsedVersion, upper) <= 0;
  }

  const terms = range.split(/\s+/).filter(Boolean);
  return terms.every((term) => satisfiesTerm(parsedVersion, term));
}

function satisfiesTerm(version: NumericVersion, term: string): boolean {
  if (term === "*") return true;
  if (term.startsWith("^")) {
    const lower = parseVersion(term.slice(1));
    if (!lower) return false;
    const upper: NumericVersion = lower.major > 0
      ? { major: lower.major + 1, minor: 0, patch: 0 }
      : lower.minor > 0
        ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 };
    return compareVersion(version, lower) >= 0 && compareVersion(version, upper) < 0;
  }
  if (term.startsWith("~")) {
    const lower = parseVersion(term.slice(1));
    if (!lower) return false;
    const upper = { major: lower.major, minor: lower.minor + 1, patch: 0 };
    return compareVersion(version, lower) >= 0 && compareVersion(version, upper) < 0;
  }
  const comparison = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
  if (!comparison) return false;
  const operator = comparison[1] ?? "=";
  const targetText = comparison[2]!;
  if (/[xX*]/.test(targetText)) {
    const parts = targetText.split(".");
    if (parts[0] !== undefined && !/[xX*]/.test(parts[0]) && Number(parts[0]) !== version.major) return false;
    if (parts[1] !== undefined && !/[xX*]/.test(parts[1]) && Number(parts[1]) !== version.minor) return false;
    if (parts[2] !== undefined && !/[xX*]/.test(parts[2]) && Number(parts[2]) !== version.patch) return false;
    return true;
  }
  const target = parseVersion(targetText);
  if (!target) return false;
  const comparisonValue = compareVersion(version, target);
  if (operator === ">=") return comparisonValue >= 0;
  if (operator === "<=") return comparisonValue <= 0;
  if (operator === ">") return comparisonValue > 0;
  if (operator === "<") return comparisonValue < 0;
  return comparisonValue === 0;
}

type NumericVersion = { major: number; minor: number; patch: number };

function parseVersion(value: string): NumericVersion | undefined {
  const match = /^(?:v)?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersion(left: NumericVersion, right: NumericVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function selectVersion(
  supportedVersions: string[],
  offeredRanges: string[],
  satisfies: (version: string, range: string) => boolean,
): string | undefined {
  return supportedVersions.find((version) => offeredRanges.some((range) => satisfies(version, range)));
}

function selectCodec(
  offered: { id: string; versions: string[] }[],
  supported: { id: string; versions: string[] }[],
): { id: string; version: string } | undefined {
  for (const supportedCodec of supported) {
    const offeredCodec = offered.find((codec) => codec.id === supportedCodec.id);
    if (!offeredCodec) continue;
    const version = supportedCodec.versions.find((item) => offeredCodec.versions.includes(item));
    if (version) return { id: supportedCodec.id, version };
  }
  return undefined;
}

function intersectLimits(offered: ProtocolLimits, ceilings: ProtocolLimits): ProtocolLimits {
  return Object.fromEntries(
    Object.entries(offered).map(([name, value]) => [
      name,
      Math.min(value, ceilings[name as keyof ProtocolLimits]),
    ]),
  ) as ProtocolLimits;
}

function reason(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

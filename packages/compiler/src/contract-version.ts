const exactVersionPattern = /^([1-9][0-9]*)$/;
const compatibleVersionPattern = /^\^([1-9][0-9]*)$/;
const boundedVersionPattern = /^>=([1-9][0-9]*) <([1-9][0-9]*)$/;
const MAX_VERSION_SPAN = 32;

/**
 * Action contracts use integer protocol versions. Ranges stay deliberately
 * finite so provider schemas and validators can share an exact version set.
 */
export function actionContractVersions(range: string): readonly number[] | undefined {
  const exact = exactVersionPattern.exec(range);
  if (exact) return [Number(exact[1])];

  const compatible = compatibleVersionPattern.exec(range);
  if (compatible) return [Number(compatible[1])];

  const bounded = boundedVersionPattern.exec(range);
  if (!bounded) return undefined;
  const minimum = Number(bounded[1]);
  const maximum = Number(bounded[2]);
  if (maximum <= minimum || maximum - minimum > MAX_VERSION_SPAN) return undefined;
  return Array.from({ length: maximum - minimum }, (_, index) => minimum + index);
}

export function matchesActionContractVersion(version: number, range: string): boolean {
  return actionContractVersions(range)?.includes(version) ?? false;
}

export function hasAllProps(obj: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((k) => obj[k] != null);
}

import {
  canonicalEncode,
  formatSha256Hash,
  webCryptoSha256Provider,
  type HashProvider,
  type Sha256Hash,
} from "@open-generative/protocol";

export async function hashNamespacedCanonical(
  namespace: string,
  value: unknown,
  provider: HashProvider = webCryptoSha256Provider,
): Promise<Sha256Hash> {
  if (!/^[a-z][a-z0-9.-]+$/.test(namespace)) {
    throw new TypeError("Hash namespace must be a lowercase dot-qualified token.");
  }
  if (provider.algorithm !== "SHA-256") {
    throw new TypeError("Hash provider must implement SHA-256.");
  }

  const prefix = new TextEncoder().encode(`${namespace}\0`);
  const content = canonicalEncode(value);
  const bytes = new Uint8Array(prefix.byteLength + content.byteLength);
  bytes.set(prefix, 0);
  bytes.set(content, prefix.byteLength);
  return formatSha256Hash(await provider.digest(bytes));
}

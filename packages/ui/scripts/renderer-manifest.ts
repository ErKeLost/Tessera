import {
  createOfficialCatalog,
  createOfficialRendererRelease,
  createSingleChunkOfficialRendererArtifactSet,
  verifyOfficialRendererRelease,
} from "@open-generative/components";
import { sha256HashSchema, type Sha256Hash } from "@open-generative/protocol";

const manifestUrl = new URL("../dist/renderer-manifest.json", import.meta.url);
const releaseUrl = new URL("../dist/renderer-release.json", import.meta.url);
const chunkUrl = new URL("../dist/index.mjs", import.meta.url);
const stylesheetUrl = new URL("../dist/styles.css", import.meta.url);

async function hashFile(url: URL): Promise<Sha256Hash> {
  const bytes = await Bun.file(url).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return sha256HashSchema.parse(`sha256:${digest}`);
}

async function createReleaseInputs() {
  const [catalog, chunkHash, stylesheetHash] = await Promise.all([
    createOfficialCatalog(),
    hashFile(chunkUrl),
    hashFile(stylesheetUrl),
  ]);
  const artifacts = createSingleChunkOfficialRendererArtifactSet({ chunkHash, stylesheetHash });
  const release = await createOfficialRendererRelease(catalog, artifacts);
  return { catalog, release };
}

async function main() {
  const command = process.argv[2] ?? "write-and-verify";
  if (!new Set(["write", "verify", "write-and-verify"]).has(command)) {
    throw new TypeError("Expected renderer manifest command: write, verify, or write-and-verify.");
  }
  const release = await createReleaseInputs();
  if (command === "write" || command === "write-and-verify") {
    await Promise.all([
      Bun.write(manifestUrl, `${JSON.stringify(release.release.manifest, null, 2)}\n`),
      Bun.write(releaseUrl, `${JSON.stringify(release.release, null, 2)}\n`),
    ]);
  }
  if (command === "verify" || command === "write-and-verify") {
    const [storedManifest, storedRelease] = await Promise.all([
      Bun.file(manifestUrl).json(),
      Bun.file(releaseUrl).json(),
    ]);
    if (JSON.stringify(storedManifest) !== JSON.stringify(storedRelease.manifest)) {
      throw new Error("Renderer manifest export does not match the verified release.");
    }
    const verifiedRelease = await verifyOfficialRendererRelease(storedRelease, release.catalog);
    if (JSON.stringify(verifiedRelease) !== JSON.stringify(release.release)) {
      throw new Error("Verified renderer release does not match the current JS and CSS artifacts.");
    }
  }
}

await main();

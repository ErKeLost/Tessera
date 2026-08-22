import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createOfficialChartRecipeManifest,
  officialChartAccessibilityFixtures,
  officialChartSpecFixtures,
  officialRendererExpectationFixtures,
  verifyChartRecipeManifest,
} from "./chart-fixtures";
import {
  chartCapabilityTokens,
  officialChartRecipeDefinitions,
  officialChartRecipeSource,
  verifyChartRecipeDefinitions,
} from "./chart-recipes";
import { createOfficialCatalog } from "./contracts";
import {
  compositionRecipeSchema,
  officialComponentFixtures,
  officialComponentTypes,
  officialCompositionRecipes,
} from "./fixtures";

describe("chart recipe coverage", () => {
  test("maps every pinned registry recipe exactly once", () => {
    const chartsDirectory = fileURLToPath(new URL("../../../vendor/shadcn-ui/apps/v4/registry/new-york-v4/charts/", import.meta.url));
    const files = readdirSync(chartsDirectory).sort();
    const recipeFiles = files.filter((file) => file.startsWith("chart-") && file.endsWith(".tsx"));
    const mappedFiles = officialChartRecipeDefinitions.map((recipe) => recipe.sourceFile.replace("charts/", "")).sort();

    expect(files).toHaveLength(71);
    expect(recipeFiles).toHaveLength(70);
    expect(mappedFiles).toEqual(recipeFiles);
    expect(new Set(officialChartRecipeDefinitions.map((recipe) => recipe.recipeName)).size).toBe(70);
    expect(() => verifyChartRecipeDefinitions(officialChartRecipeDefinitions)).not.toThrow();

    const counts = Object.fromEntries(["area", "bar", "line", "pie", "radar", "radial", "tooltip"].map((family) => [
      family,
      officialChartRecipeDefinitions.filter((recipe) => recipe.family === family).length,
    ]));
    expect(counts).toEqual({ area: 10, bar: 10, line: 10, pie: 11, radar: 14, radial: 6, tooltip: 9 });
  });

  test("pins exact source and dependency provenance without claiming renderer hashes", async () => {
    expect(officialChartRecipeSource).toMatchObject({
      upstreamCommit: "25be24cca34d06eed29a4779c3f48c4816aa812c",
      registryTree: "addee626e9f09551ff366c62deffebedea6bcac2",
      registryListingHash: "sha256:d80981943fe3f674a49b8020df7b6015f63796e95b4b3e153cd742a6ffb82e8e",
      vendorLockfileHash: "sha256:4cdeb1a0cb106189fb36681f435e80a10a676aea41cffee22e059a3b2d49ac7a",
      recipeFileCount: 70,
    });
    expect("rendererImplementationHash" in officialChartRecipeSource).toBe(false);
    expect("rendererCapabilityManifestHash" in officialChartRecipeSource).toBe(false);

    const vendorRoot = fileURLToPath(new URL("../../../vendor/shadcn-ui/", import.meta.url));
    const head = Bun.spawnSync(["git", "-C", vendorRoot, "rev-parse", "HEAD"]);
    expect(head.exitCode).toBe(0);
    expect(head.stdout.toString().trim()).toBe(officialChartRecipeSource.upstreamCommit);

    const listing = Bun.spawnSync([
      "git",
      "-C",
      vendorRoot,
      "ls-tree",
      "-r",
      "HEAD",
      officialChartRecipeSource.registryPath,
    ]);
    expect(listing.exitCode).toBe(0);
    const listingHash = new Bun.CryptoHasher("sha256").update(listing.stdout).digest("hex");
    expect(`sha256:${listingHash}`).toBe(officialChartRecipeSource.registryListingHash);

    const worktreeDiff = Bun.spawnSync([
      "git",
      "-C",
      vendorRoot,
      "status",
      "--porcelain",
      "--",
      officialChartRecipeSource.registryPath,
    ]);
    expect(worktreeDiff.exitCode).toBe(0);
    expect(worktreeDiff.stdout.toString()).toBe("");

    const lockfile = await Bun.file(new URL("../../../vendor/shadcn-ui/pnpm-lock.yaml", import.meta.url)).arrayBuffer();
    const lockfileHash = new Bun.CryptoHasher("sha256").update(lockfile).digest("hex");
    expect(`sha256:${lockfileHash}`).toBe(officialChartRecipeSource.vendorLockfileHash);
  });

  test("keeps dashed tooltip indicators as an API capability without inventing a snapshot recipe", () => {
    expect(chartCapabilityTokens).toContain("tooltip.indicator.dashed");
    expect(officialChartRecipeDefinitions.some((recipe) => (
      recipe.requiredCapabilities.includes("tooltip.indicator.dashed")
    ))).toBe(false);
  });

  test("binds every recipe to one valid spec, renderer expectation, and accessibility fixture", () => {
    expect(officialChartSpecFixtures).toHaveLength(70);
    expect(officialRendererExpectationFixtures).toHaveLength(70);
    expect(officialChartAccessibilityFixtures).toHaveLength(70);
    for (const [index, recipe] of officialChartRecipeDefinitions.entries()) {
      expect(officialChartSpecFixtures[index]?.recipeName).toBe(recipe.recipeName);
      expect(officialRendererExpectationFixtures[index]?.recipeName).toBe(recipe.recipeName);
      expect(officialRendererExpectationFixtures[index]?.requiredCapabilities).toEqual(recipe.requiredCapabilities);
      expect(officialChartAccessibilityFixtures[index]?.recipeName).toBe(recipe.recipeName);
      expect(officialChartAccessibilityFixtures[index]?.dataSemantics).toBe("preserved-in-equivalent-view");
    }
  });

  test("hashes the complete recipe and fixture manifest deterministically", async () => {
    const catalog = await createOfficialCatalog();
    const [left, right] = await Promise.all([
      createOfficialChartRecipeManifest(catalog),
      createOfficialChartRecipeManifest(catalog),
    ]);
    expect(left.recipeManifestHash).toBe(right.recipeManifestHash);
    expect(left.contractSetHash).toBe(catalog.manifest.contractSetHash);
    expect(left.dataChartContract).toEqual(catalog.components.dataChart.ref);
    await expect(verifyChartRecipeManifest(left)).resolves.toEqual(left);

    const tampered = structuredClone(left);
    tampered.accessibilityFixtures[0]!.accessibleName = "Changed after hashing";
    await expect(verifyChartRecipeManifest(tampered)).rejects.toThrow("hash mismatch");
  });
});

describe("official component fixtures and composition recipes", () => {
  test("provides one authoring/resolved fixture for each official component", () => {
    expect(officialComponentFixtures).toHaveLength(12);
    expect(officialComponentFixtures.map((fixture) => fixture.componentType).sort()).toEqual([...officialComponentTypes].sort());
  });

  test("keeps composition recipes framework-neutral, referentially valid, and acyclic", () => {
    expect(officialCompositionRecipes.length).toBeGreaterThan(0);
    const forbiddenPresentationKey = ["class", "Name"].join("");
    for (const recipe of officialCompositionRecipes) {
      expect(compositionRecipeSchema.parse(recipe)).toEqual(recipe);
      expect(JSON.stringify(recipe)).not.toContain(forbiddenPresentationKey);
      expect(JSON.stringify(recipe)).not.toContain("style");
    }
  });
});

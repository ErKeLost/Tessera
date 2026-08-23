import { describe, expect, test } from "bun:test";
import {
  createOfficialChartRecipeManifest,
  officialChartAccessibilityFixtures,
  officialChartSpecFixtures,
  officialRendererExpectationFixtures,
  verifyChartRecipeManifest,
} from "./chart-fixtures";
import {
  officialChartRecipeDefinitions,
  officialChartRecipeSource,
  verifyChartRecipeDefinitions,
} from "./chart-recipes";
import { chartRecipes } from "./chart-spec";
import { createOfficialCatalog } from "./contracts";
import { officialComponentFixtures, officialComponentTypes, officialCompositionRecipes } from "./fixtures";

describe("chart recipe coverage", () => {
  test("declares every final recipe exactly once in canonical order", () => {
    expect(officialChartRecipeDefinitions.map((recipe) => recipe.recipeName)).toEqual([...chartRecipes]);
    expect(new Set(officialChartRecipeDefinitions.map((recipe) => recipe.recipeName)).size).toBe(17);
    expect(() => verifyChartRecipeDefinitions(officialChartRecipeDefinitions)).not.toThrow();
    expect(officialChartRecipeSource).toMatchObject({
      sourceKind: "reference-design-set",
      designSystem: "shadcn/ui",
      recipeCount: 17,
      rendererPackages: { chartEngine: { packageName: "recharts", version: "3.10.1" } },
    });
  });

  test("binds each recipe to authoring, resolved, renderer, and accessibility fixtures", () => {
    expect(officialChartSpecFixtures).toHaveLength(17);
    expect(officialRendererExpectationFixtures).toHaveLength(17);
    expect(officialChartAccessibilityFixtures).toHaveLength(17);
    for (const [index, recipe] of officialChartRecipeDefinitions.entries()) {
      expect(officialChartSpecFixtures[index]?.recipeName).toBe(recipe.recipeName);
      expect(officialChartSpecFixtures[index]?.resolvedSpec.recipe).toBe(recipe.recipeName);
      expect(officialRendererExpectationFixtures[index]?.requiredCapabilities).toEqual(recipe.requiredCapabilities);
      expect(officialChartAccessibilityFixtures[index]?.dataSemantics).toBe("preserved-in-equivalent-view");
    }
  });

  test("hashes the complete recipe manifest deterministically", async () => {
    const catalog = await createOfficialCatalog();
    const [left, right] = await Promise.all([
      createOfficialChartRecipeManifest(catalog),
      createOfficialChartRecipeManifest(catalog),
    ]);
    expect(left).toEqual(right);
    await expect(verifyChartRecipeManifest(left)).resolves.toEqual(left);
    const tampered = structuredClone(left);
    tampered.accessibilityFixtures[0]!.accessibleName = "Changed after hashing";
    await expect(verifyChartRecipeManifest(tampered)).rejects.toThrow("hash mismatch");
  });
});

describe("official component fixtures", () => {
  test("contains the official component fixtures and chart composition", () => {
    expect(officialComponentTypes).toHaveLength(6);
    expect(officialComponentFixtures).toHaveLength(6);
    expect(officialComponentFixtures[0]?.componentType).toBe("data.chart");
    expect(officialCompositionRecipes).toHaveLength(1);
    expect(officialCompositionRecipes[0]?.nodes).toHaveLength(1);
  });
});

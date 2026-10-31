import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatProviderModelContextWindow,
  groupProviderModelOptions,
  ProviderModelPicker,
} from "./openrouter-model-picker";
import { EffortSlider } from "./effort-slider";

describe("ProviderModelPicker", () => {
  test("uses fixed skeleton placeholders while the model catalog loads", () => {
    const html = renderToStaticMarkup(
      <ProviderModelPicker
        loading
        models={[]}
        onValueChange={() => undefined}
        variant="composer"
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading models"');
    expect(html.match(/data-slot="skeleton"/gu)).toHaveLength(2);
    expect(html).toContain("studio-model-picker-skeleton-icon");
    expect(html).toContain("studio-model-picker-skeleton-label");
    expect(html).not.toContain("spin");
  });

  test("reveals the selected model without changing the trigger slot", () => {
    const html = renderToStaticMarkup(
      <ProviderModelPicker
        models={[{ id: "openai/gpt-test", name: "GPT Test", family: "OpenAI" }]}
        onValueChange={() => undefined}
        value="openai/gpt-test"
        variant="composer"
      />,
    );

    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain("studio-model-picker-current t-skel is-revealed");
    expect(html).toContain("GPT Test");
  });

  test("groups models by provider family and formats context length", () => {
    const groups = groupProviderModelOptions([
      { id: "openai/gpt-test", name: "GPT Test", family: "OpenAI", contextWindow: 128_000 },
      { id: "openai/gpt-mini", name: "GPT Mini", family: "OpenAI" },
      { id: "anthropic/claude-test", name: "Claude Test", family: "Anthropic" },
    ]);

    expect(groups.map(({ family, items }) => [family, items.length])).toEqual([
      ["OpenAI", 2],
      ["Anthropic", 1],
    ]);
    expect(groups[0]?.items[0]?.contextWindow).toBe(128_000);
    expect(formatProviderModelContextWindow(128_000)).toBe("128K context");
  });

  test("renders Orbit's effort slider with the selected model levels", () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        levels={["default", "low", "medium", "high"]}
        value="high"
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Effort High"');
    expect(html).toContain('aria-valuetext="High"');
    expect(html).toContain("effort-slider-brain");
    expect(html).toContain("effort-slider-galaxy");
  });
});

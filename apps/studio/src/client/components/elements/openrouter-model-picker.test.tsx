import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenRouterModelPicker } from "./openrouter-model-picker";

describe("OpenRouterModelPicker", () => {
  test("uses fixed skeleton placeholders while the model catalog loads", () => {
    const html = renderToStaticMarkup(
      <OpenRouterModelPicker
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
      <OpenRouterModelPicker
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
});

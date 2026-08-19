import { describe, expect, test } from "bun:test";
import type { CalculatorArtifact as CalculatorArtifactData } from "@data-elements/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorArtifact } from "./calculator-artifact";

const artifact: CalculatorArtifactData = {
  protocolVersion: "1.0",
  kind: "calculator",
  id: "compound-interest",
  title: "Compound interest",
  description: "Explore future value.",
  calculatorId: "compound-interest",
  initialValues: { principal: 10_000, rate: 5, years: 20 },
  currency: "USD",
  locale: "en-US",
};

describe("CalculatorArtifact", () => {
  test("uses a single artifact surface with explicit controls, result, and chart regions", () => {
    const markup = renderToStaticMarkup(
      <CalculatorArtifact artifact={artifact} />,
    );

    expect(markup).toContain('data-slot="calculator-layout"');
    expect(markup).toContain('data-slot="calculator-controls"');
    expect(markup).toContain('data-slot="calculator-formula"');
    expect(markup).toContain('data-slot="calculator-result"');
    expect(markup).toContain('data-slot="calculator-chart"');
    expect(markup).toContain("de-calculator-formula de-field rounded-xl");
    expect(markup).toContain("de-calculator-result de-field");
    expect(markup).not.toContain("de-calculator-result de-field w-fit");
    expect(markup).toContain("de-calculator-chart de-field");
    expect(markup).toContain("de-calculator-input-value de-field inline-flex");
    expect(markup.indexOf('data-slot="calculator-chart"')).toBeLessThan(
      markup.indexOf('data-slot="calculator-result"'),
    );
    expect(markup).not.toContain("border-t");
    expect(markup).not.toContain("border-b");
    expect(markup).not.toContain("border-y");
  });
});

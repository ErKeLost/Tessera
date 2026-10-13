import { describe, expect, test } from "bun:test";
import { splitAnalysisFence } from "./analysis-fence";

describe("splitAnalysisFence", () => {
  test("separates prose from a closed analysis program", () => {
    const { prose, code } = splitAnalysisFence([
      "Revenue rose in all three regions.",
      "",
      "```openui-lang",
      "root = Stack([a])",
      "a = Metric(\"Revenue\", \"$1.2M\")",
      "```",
      "",
      "Coverage was complete.",
    ].join("\n"));

    expect(prose).toBe("Revenue rose in all three regions.\n\nCoverage was complete.");
    expect(code).toBe("root = Stack([a])\na = Metric(\"Revenue\", \"$1.2M\")");
  });

  test("treats an unterminated trailing fence as a program still streaming", () => {
    const { prose, code } = splitAnalysisFence(
      "Revenue rose.\n\n```openui-lang\nroot = Stack([a])\na = Metric(\"Rev",
    );

    expect(prose).toBe("Revenue rose.");
    expect(code).toBe("root = Stack([a])\na = Metric(\"Rev");
  });

  test("keeps non-analysis fences in the prose", () => {
    const source = "Run this:\n\n```sql\nselect 1\n```\n\nDone.";
    const { prose, code } = splitAnalysisFence(source);

    expect(prose).toBe(source);
    expect(code).toBe("");
  });

  test("returns empty parts for an empty message", () => {
    expect(splitAnalysisFence("")).toEqual({ prose: "", code: "" });
  });

  test("merges several analysis fences into one program", () => {
    const { code } = splitAnalysisFence(
      "```openui-lang\nroot = Stack([a])\n```\ntext\n```openui-lang\na = Metric(\"R\", \"1\")\n```",
    );

    expect(code).toBe("root = Stack([a])\na = Metric(\"R\", \"1\")");
  });
});

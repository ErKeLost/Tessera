import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TesseraToolFallback, tesseraStudioToolkit } from "./tessera-toolkit";

describe("Tessera Studio toolkit", () => {
  test("registers every current business tool renderer", () => {
    expect(Object.keys(tesseraStudioToolkit).sort()).toEqual([
      "execute_sql",
      "list_database",
      "prepare_analysis",
      "read_feishu_document",
      "search_data_context",
      "search_feishu_documents",
    ]);
  });

  test("keeps a failed tool payload folded by default", () => {
    const html = renderToStaticMarkup(createElement(TesseraToolFallback, {
      type: "tool-call",
      toolCallId: "failed-call",
      toolName: "prepare_analysis",
      args: {},
      argsText: "{}",
      result: { status: "failed", message: "Validation failed" },
      status: { type: "complete" },
      addResult() {},
      resume() {},
      respondToApproval() {},
    }));
    expect(html).toContain('data-state="closed"');
    expect(html).toContain("failed");
    expect(html).not.toContain("Validation failed");
  });
});

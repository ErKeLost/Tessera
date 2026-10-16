import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerApprovalDialog } from "./answer-approval-dialog";
import type { AnswerApprovalPrompt } from "./answer-approval";

const prompt: AnswerApprovalPrompt = {
  status: "awaiting_approval",
  requestId: "req-1",
  checkpointId: "cp-1",
  operation: "Delete",
  target: "public.orders",
  risk: "destructive",
  title: "Delete rows",
  summary: "This removes 2 rows.",
  compiledSql: "DELETE FROM orders WHERE status = $1",
  parameters: ["test"],
};

describe("AnswerApprovalDialog", () => {
  test("shows the permission decision the server made", () => {
    const html = renderToStaticMarkup(<AnswerApprovalDialog onDecide={() => {}} prompt={prompt} />);

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Delete");
    expect(html).toContain("public.orders");
    expect(html).toContain("destructive");
    expect(html).toContain("DELETE FROM orders");
    expect(html).toContain("Approve");
    expect(html).toContain("Decline");
  });

  test("falls back to safe copy without a compiled statement", () => {
    const html = renderToStaticMarkup(
      <AnswerApprovalDialog
        onDecide={() => {}}
        prompt={{ status: "awaiting_approval", requestId: "r", checkpointId: "c", operation: "Update", target: "public.users" }}
      />,
    );

    expect(html).toContain("Review database change");
    expect(html).not.toContain("<pre>");
  });
});

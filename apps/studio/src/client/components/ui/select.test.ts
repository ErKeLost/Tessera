import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { SelectContent } from "./select";

describe("SelectContent", () => {
  test("opens as a popper below the trigger by default", () => {
    const portal = SelectContent({ children: null });

    expect(isValidElement(portal)).toBe(true);
    if (!isValidElement<{ children?: unknown }>(portal)) {
      throw new Error("SelectContent did not render a portal.");
    }

    const content = portal.props.children;
    if (
      !isValidElement<{ position?: unknown; align?: unknown }>(content)
    ) {
      throw new Error("SelectContent did not render its portal content.");
    }

    expect(content.props.position).toBe("popper");
    expect(content.props.align).toBe("start");
  });
});

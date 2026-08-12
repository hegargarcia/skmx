import { describe, expect, it } from "vitest";
import { createProgram } from "../src/commands.ts";

describe("CLI surface", () => {
  it("shows the five public commands", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("setup");
    expect(help).toContain("sync");
    expect(help).toContain("status");
    expect(help).toContain("logs");
    expect(help).toContain("uninstall");
    expect(help).not.toContain("_scheduled");
    expect(help).not.toContain("watch");
  });
});

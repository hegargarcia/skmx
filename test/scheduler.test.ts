import { describe, expect, it } from "vitest";
import { cronEntry, launchAgentPlist } from "../src/scheduler.ts";

describe("interval scheduling", () => {
  it("renders an owned Linux cron entry with safely quoted arguments", () => {
    expect(cronEntry(15, ["/path with space/npx", "--yes", "skill-sync@0.1.0", "_scheduled"], "/tmp/sync log")).toBe(
      "*/15 * * * * '/path with space/npx' '--yes' 'skill-sync@0.1.0' '_scheduled' >> '/tmp/sync log' 2>&1 # skill-sync managed job",
    );
    expect(cronEntry(60, ["npx"], "/tmp/log")).toMatch(/^0 \* \* \* \*/);
  });

  it("renders a launchd agent with exact interval and escaped paths", () => {
    const plist = launchAgentPlist(5, ["/opt/npm&node/npx", "_scheduled"], "/tmp/a<b.log");
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("/opt/npm&amp;node/npx");
    expect(plist).toContain("/tmp/a&lt;b.log");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  it("rejects intervals cron cannot represent in V1", () => {
    expect(() => cronEntry(0, ["npx"], "/tmp/log")).toThrow("1 to 60");
    expect(() => cronEntry(61, ["npx"], "/tmp/log")).toThrow("1 to 60");
    expect(() => cronEntry(7, ["npx"], "/tmp/log")).toThrow("divides evenly");
  });
});

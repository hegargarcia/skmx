import { describe, expect, it } from "vitest";
import { cronEntry, launchAgentPlist, parseCrontabList } from "../src/scheduler.ts";

describe("interval scheduling", () => {
  it("renders an owned Linux cron entry with safely quoted arguments", () => {
    expect(cronEntry(15, ["/path with space/npx", "--yes", "skmx@0.1.0", "_scheduled"], "/tmp/sync log")).toBe(
      "*/15 * * * * '/path with space/npx' '--yes' 'skmx@0.1.0' '_scheduled' >> '/tmp/sync log' 2>&1 # skmx managed job",
    );
    expect(cronEntry(60, ["npx"], "/tmp/log")).toMatch(/^0 \* \* \* \*/);
  });

  it("renders a launchd agent with exact interval and escaped paths", () => {
    const plist = launchAgentPlist(
      5,
      ["/opt/npm&node/npx", "_scheduled"],
      "/tmp/a<b.log",
      { PATH: "/opt/node&npm/bin", SKMX_HOME: "/tmp/custom<state" },
    );
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("/opt/npm&amp;node/npx");
    expect(plist).toContain("/tmp/a&lt;b.log");
    expect(plist).toContain("<key>SKMX_HOME</key>");
    expect(plist).toContain("/tmp/custom&lt;state");
    expect(plist).toContain("/opt/node&amp;npm/bin");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  it("persists custom homes and the Node path in cron", () => {
    const line = cronEntry(15, ["/opt/node/bin/npx", "_scheduled"], "/tmp/log", {
      PATH: "/opt/node/bin:/usr/bin",
      SKMX_HOME: "/tmp/custom state",
    });
    expect(line).toContain("PATH='/opt/node/bin:/usr/bin'");
    expect(line).toContain("SKMX_HOME='/tmp/custom state'");
  });

  it("distinguishes a missing crontab from a read failure", () => {
    expect(parseCrontabList(1, "", "no crontab for user")).toEqual([]);
    expect(parseCrontabList(0, "MAILTO=me@example.com\n\n0 1 * * * backup\n", "")).toEqual([
      "MAILTO=me@example.com",
      "",
      "0 1 * * * backup",
    ]);
    expect(() => parseCrontabList(1, "", "permission denied")).toThrow("could not read");
  });

  it("rejects intervals cron cannot represent in V1", () => {
    expect(() => cronEntry(0, ["npx"], "/tmp/log")).toThrow("1 to 60");
    expect(() => cronEntry(61, ["npx"], "/tmp/log")).toThrow("1 to 60");
    expect(() => cronEntry(7, ["npx"], "/tmp/log")).toThrow("divides evenly");
  });
});

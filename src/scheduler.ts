import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";

const CRON_MARKER = "# skill-sync managed job";
const PACKAGE_REFERENCE = `${packageJson.name}@${packageJson.version}`;

export type SupportedPlatform = "linux" | "darwin";

export async function installSchedule(
  config: Config,
  platform: NodeJS.Platform = process.platform,
) {
  assertSupportedPlatform(platform);
  const command = await scheduledCommand();
  if (platform === "linux") {
    await installCron(config.intervalMinutes, command, config.schedulerLogPath);
    return "cron" as const;
  }
  await installLaunchAgent(config, command);
  return "launchd" as const;
}

export async function uninstallSchedule(
  config: Pick<Config, "launchAgentPath">,
  platform: NodeJS.Platform = process.platform,
) {
  assertSupportedPlatform(platform);
  if (platform === "linux") return removeCron();

  const existed = await access(config.launchAgentPath).then(() => true).catch(() => false);
  if (!existed) return false;
  await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, config.launchAgentPath], {
    reject: false,
  });
  await rm(config.launchAgentPath, { force: true });
  return true;
}

export function cronEntry(intervalMinutes: number, command: string[], logPath: string) {
  assertInterval(intervalMinutes);
  const expression = intervalMinutes === 60 ? "0 * * * *" : `*/${intervalMinutes} * * * *`;
  return `${expression} ${command.map(shellQuote).join(" ")} >> ${shellQuote(logPath)} 2>&1 ${CRON_MARKER}`;
}

export function launchAgentPlist(intervalMinutes: number, command: string[], logPath: string) {
  assertInterval(intervalMinutes);
  const argumentsXml = command
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.skill-sync.sync</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>StartInterval</key>
    <integer>${intervalMinutes * 60}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
  </dict>
</plist>
`;
}

async function installCron(intervalMinutes: number, command: string[], logPath: string) {
  const current = await execa("crontab", ["-l"], { reject: false });
  const lines = current.exitCode === 0 ? withoutManagedCron(current.stdout) : [];
  lines.push(cronEntry(intervalMinutes, command, logPath));
  const result = await execa("crontab", ["-"], { input: `${lines.join("\n")}\n`, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`could not install the cron job: ${result.stderr.trim() || "crontab failed"}`);
  }
}

async function removeCron() {
  const current = await execa("crontab", ["-l"], { reject: false });
  if (current.exitCode !== 0 || !current.stdout.includes(CRON_MARKER)) return false;
  const lines = withoutManagedCron(current.stdout);
  const result = await execa("crontab", ["-"], { input: `${lines.join("\n")}\n`, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`could not remove the cron job: ${result.stderr.trim() || "crontab failed"}`);
  }
  return true;
}

function withoutManagedCron(contents: string) {
  const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (normalized === "") return [];
  return normalized.split("\n").filter((line) => !line.includes(CRON_MARKER));
}

async function installLaunchAgent(config: Config, command: string[]) {
  await mkdir(dirname(config.launchAgentPath), { recursive: true });
  await mkdir(dirname(config.schedulerLogPath), { recursive: true });
  await writeFile(
    config.launchAgentPath,
    launchAgentPlist(config.intervalMinutes, command, config.schedulerLogPath),
    "utf8",
  );
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await execa("launchctl", ["bootout", domain, config.launchAgentPath], { reject: false });
  const result = await execa("launchctl", ["bootstrap", domain, config.launchAgentPath], {
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not load the launch agent: ${result.stderr.trim() || "launchctl failed"}`);
  }
}

async function scheduledCommand() {
  if (process.env.SKILL_SYNC_SCHEDULE_COMMAND) {
    return JSON.parse(process.env.SKILL_SYNC_SCHEDULE_COMMAND) as string[];
  }
  const npx = await findNpx();
  return [npx, "--yes", PACKAGE_REFERENCE, "_scheduled"];
}

async function findNpx() {
  const besideNode = join(dirname(process.execPath), "npx");
  if (await access(besideNode).then(() => true).catch(() => false)) return besideNode;
  const result = await execa("sh", ["-c", "command -v npx"], { reject: false });
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new Error("npx is required to register background sync and was not found on PATH");
  }
  return result.stdout.trim();
}

function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is SupportedPlatform {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`background sync is supported on Linux and macOS; found ${platform}`);
  }
}

function assertInterval(intervalMinutes: number) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
    throw new Error("the interval must be a whole number from 1 to 60 minutes");
  }
  if (60 % intervalMinutes !== 0) {
    throw new Error("Linux cron requires a V1 interval that divides evenly into one hour");
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

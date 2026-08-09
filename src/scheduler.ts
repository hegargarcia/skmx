import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";

const CRON_MARKER = "# skill-sync managed job";
const PACKAGE_REFERENCE = `${packageJson.name}@${packageJson.version}`;

export type SupportedPlatform = "linux" | "darwin";
export type SchedulerEnvironment = Record<string, string>;

export async function installSchedule(
  config: Config,
  platform: NodeJS.Platform = process.platform,
) {
  assertSupportedPlatform(platform);
  const command = await scheduledCommand();
  const environment = schedulerEnvironment(config);
  if (platform === "linux") {
    await installCron(config.intervalMinutes, command, config.schedulerLogPath, environment);
    return "cron" as const;
  }
  await installLaunchAgent(config, command, environment);
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
  const result = await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, config.launchAgentPath], {
    reject: false,
  });
  if (result.exitCode !== 0 && !/no such process|could not find service/i.test(result.stderr)) {
    throw new Error(`could not unload the launch agent: ${result.stderr.trim() || "launchctl failed"}`);
  }
  await rm(config.launchAgentPath, { force: true });
  return true;
}

export function cronEntry(
  intervalMinutes: number,
  command: string[],
  logPath: string,
  environment: SchedulerEnvironment = {},
) {
  assertInterval(intervalMinutes);
  const expression = intervalMinutes === 60 ? "0 * * * *" : `*/${intervalMinutes} * * * *`;
  const variables = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const invocation = [variables, command.map(shellQuote).join(" ")].filter(Boolean).join(" ");
  return `${expression} ${invocation} >> ${shellQuote(logPath)} 2>&1 ${CRON_MARKER}`;
}

export function launchAgentPlist(
  intervalMinutes: number,
  command: string[],
  logPath: string,
  environment: SchedulerEnvironment = {},
) {
  assertInterval(intervalMinutes);
  const argumentsXml = command
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(environment)
    .map(([name, value]) => `      <key>${escapeXml(name)}</key>\n      <string>${escapeXml(value)}</string>`)
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
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
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

async function installCron(
  intervalMinutes: number,
  command: string[],
  logPath: string,
  environment: SchedulerEnvironment,
) {
  const current = await execa("crontab", ["-l"], { reject: false });
  const lines = parseCrontabList(current.exitCode, current.stdout, current.stderr)
    .filter((line) => !isManagedCronLine(line));
  lines.push(cronEntry(intervalMinutes, command, logPath, environment));
  const result = await execa("crontab", ["-"], { input: `${lines.join("\n")}\n`, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`could not install the cron job: ${result.stderr.trim() || "crontab failed"}`);
  }
}

async function removeCron() {
  const current = await execa("crontab", ["-l"], { reject: false });
  const existing = parseCrontabList(current.exitCode, current.stdout, current.stderr);
  if (!existing.some(isManagedCronLine)) return false;
  const lines = existing.filter((line) => !isManagedCronLine(line));
  const result = await execa("crontab", ["-"], { input: `${lines.join("\n")}\n`, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`could not remove the cron job: ${result.stderr.trim() || "crontab failed"}`);
  }
  return true;
}

export function parseCrontabList(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
) {
  if (exitCode !== 0 && !/no crontab for/i.test(stderr)) {
    throw new Error(`could not read the existing crontab: ${stderr.trim() || "crontab -l failed"}`);
  }
  const contents = exitCode === 0 ? stdout : "";
  const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (normalized === "") return [];
  return normalized.split("\n");
}

function isManagedCronLine(line: string) {
  return line.trimEnd().endsWith(CRON_MARKER);
}

async function installLaunchAgent(
  config: Config,
  command: string[],
  environment: SchedulerEnvironment,
) {
  await mkdir(dirname(config.launchAgentPath), { recursive: true });
  await mkdir(dirname(config.schedulerLogPath), { recursive: true });
  await writeFile(
    config.launchAgentPath,
    launchAgentPlist(config.intervalMinutes, command, config.schedulerLogPath, environment),
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
  const npx = await findNpx();
  return [npx, "--yes", PACKAGE_REFERENCE, "_scheduled"];
}

function schedulerEnvironment(config: Config): SchedulerEnvironment {
  const path = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":"),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(":");
  return {
    PATH: path,
    SKILL_SYNC_HOME: config.home,
    SKILL_SYNC_AGENT_HOME: config.agentHome,
  };
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

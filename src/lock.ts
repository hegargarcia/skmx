import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
type LockOwner = { pid: number; startedAt: string; token: string };

export async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path, { recursive: true });
  const token = randomUUID();
  const candidate = join(path, token);
  const temporary = join(path, `.${token}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }),
      { flag: "wx", mode: 0o600 },
    );
    await link(temporary, candidate);
  } finally {
    await rm(temporary, { force: true });
  }

  try {
    if (await hasActiveContender(path, token)) {
      throw new Error("another skm run is already active");
    }
    return await operation();
  } finally {
    await rm(candidate, { force: true });
  }
}

async function hasActiveContender(directory: string, token: string) {
  const candidates = (await readdir(directory)).filter((name) => !name.startsWith(".") && name !== token);
  let active = false;
  for (const name of candidates) {
    const path = join(directory, name);
    if (await candidateIsActive(path)) active = true;
    else await rm(path, { force: true });
  }
  return active;
}

async function candidateIsActive(path: string) {
  let owner: Partial<LockOwner>;
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return candidateIsRecent(path);
  }
  if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) < 1) return candidateIsRecent(path);

  try {
    process.kill(owner.pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function candidateIsRecent(path: string) {
  const info = await stat(path).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
}

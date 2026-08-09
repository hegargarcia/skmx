import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
type LockOwner = { pid: number; startedAt: string; token: string };

export async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  await clearStaleLock(path);
  const token = randomUUID();
  const temporary = join(dirname(path), `.${basename(path)}.${token}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }),
      { flag: "wx", mode: 0o600 },
    );
    await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("another skill-sync run is already active");
      throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    return await operation();
  } finally {
    await releaseLock(path, token);
  }
}

async function clearStaleLock(path: string) {
  let owner: LockOwner;
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    await clearIncompleteLock(path);
    return;
  }
  if (!Number.isInteger(owner.pid) || owner.pid < 1) {
    await clearIncompleteLock(path);
    return;
  }

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(path, { force: true });
  }
}

async function clearIncompleteLock(path: string) {
  const info = await stat(path).catch(() => null);
  if (info && Date.now() - info.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS) {
    await rm(path, { force: true });
  }
}

async function releaseLock(path: string, token: string) {
  const owner = await readFile(path, "utf8")
    .then((contents) => JSON.parse(contents) as Partial<LockOwner>)
    .catch(() => null);
  if (owner?.token === token) await rm(path, { force: true });
}

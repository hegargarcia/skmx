import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
type LockOwner = { pid: number; startedAt: string; token: string };

export async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  await clearStaleLock(path);
  const token = randomUUID();
  const handle = await open(path, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("another skill-sync run is already active");
    throw error;
  });

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
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

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

type LockOwner = { pid: number; startedAt: string };

export async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  await clearStaleLock(path);
  const handle = await open(path, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("another skill-sync run is already active");
    throw error;
  });

  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  try {
    return await operation();
  } finally {
    await rm(path, { force: true });
  }
}

async function clearStaleLock(path: string) {
  let owner: LockOwner;
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    await rm(path, { force: true });
    return;
  }
  if (!Number.isInteger(owner.pid) || owner.pid < 1) {
    await rm(path, { force: true });
    return;
  }

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(path, { force: true });
  }
}

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const RunRecordSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  trigger: z.enum(["manual", "scheduled", "setup"]),
  status: z.enum(["ok", "conflict", "error"]),
  summary: z.string(),
  commit: z.string().nullable(),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

export async function appendRun(path: string, record: RunRecord) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readRuns(path: string, limit = 20) {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return RunRecordSchema.safeParse(JSON.parse(line));
      } catch {
        return RunRecordSchema.safeParse(null);
      }
    })
    .filter((result) => result.success)
    .map((result) => result.data)
    .slice(-limit)
    .reverse();
}

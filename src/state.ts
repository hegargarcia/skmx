import { z } from "zod";

const SyncRecordSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["ok", "diverged", "conflict", "error"]),
  summary: z.string(),
  commit: z.string().nullable(),
});

export type SyncRecord = z.infer<typeof SyncRecordSchema>;

export async function readLastSync(statePath: string) {
  const file = Bun.file(statePath);
  if (!(await file.exists())) return null;

  const parsed = SyncRecordSchema.safeParse(await file.json());
  return parsed.success ? parsed.data : null;
}

export async function writeLastSync(statePath: string, record: SyncRecord) {
  await Bun.write(statePath, `${JSON.stringify(record, null, 2)}\n`);
}

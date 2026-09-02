import zlib from "zlib";
import { DateTime } from "luxon";
import { sql } from "./db";
import { Times } from "./core";
import { sendMail } from "./mailer";

/**
 * Full database backup as a gzipped JSON export, emailed as an attachment.
 * The `settings` table is deliberately excluded (it holds the mail app password).
 * The JSON is restorable via scripts/restore-backup.mjs.
 */
const TABLES = [
  "employees", "time_entries", "schedules", "payments",
  "clockin_alerts", "medications", "med_times", "med_fired",
];

export async function buildBackup(now: DateTime = Times.now()): Promise<{ filename: string; content: Buffer; counts: Record<string, number> }> {
  const db = sql();
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await db.unsafe(`select * from ${t}`); // t is from a fixed whitelist
    tables[t] = rows;
    counts[t] = rows.length;
  }
  const payload = { app: "timekeeper", version: 1, exportedAt: Times.format(now), tables };
  const content = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const filename = `timekeeper-${now.toFormat("yyyy-MM-dd")}.json.gz`;
  return { filename, content, counts };
}

export async function sendBackup(now: DateTime = Times.now()): Promise<string> {
  const { filename, content, counts } = await buildBackup(now);
  const summary = Object.entries(counts).map(([t, n]) => `  ${t}: ${n}`).join("\n");
  const text = `TimeKeeper database backup — ${filename}\n\nRow counts:\n${summary}\n\nThe attached .json.gz is a full export of the database.`;
  await sendMail(`TimeKeeper backup ${now.toFormat("yyyy-MM-dd")}`, text, [{ filename, content }]);
  return `Backup sent (${filename}).`;
}

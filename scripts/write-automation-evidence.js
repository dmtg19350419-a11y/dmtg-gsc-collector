import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw evidenceError("AUTOMATION_EVIDENCE_TIME_INVALID");
  return date;
}

function isoWeek(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function writeWeeklyEvidence({ outputDir, completedAt, githubSha, sourceCommit, status } = {}) {
  const completed = exactIso(completedAt);
  if (!/^[a-f0-9]{40}$/.test(String(githubSha || "")) || !/^[a-f0-9]{40}$/.test(String(sourceCommit || "")) || status !== "completed") {
    throw evidenceError("AUTOMATION_EVIDENCE_INPUT_INVALID");
  }
  const resolved = path.resolve(String(outputDir || ""));
  if (!resolved || resolved === "/") throw evidenceError("AUTOMATION_EVIDENCE_PATH_INVALID");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o755 });
  const filePath = path.join(resolved, `${isoWeek(completed)}.json`);
  if (fs.existsSync(filePath)) return { created: false, file: path.basename(filePath) };
  const record = { completedAt, githubSha, sourceCommit, status: "completed" };
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  return { created: true, file: path.basename(filePath) };
}

function value(argv, name) {
  const prefix = `--${name}=`;
  return String(argv.find((item) => item.startsWith(prefix)) || "").slice(prefix.length);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const argv = process.argv.slice(2);
    const report = writeWeeklyEvidence({
      outputDir: value(argv, "output"),
      completedAt: value(argv, "completed-at"),
      githubSha: value(argv, "github-sha"),
      sourceCommit: value(argv, "source-commit"),
      status: value(argv, "status"),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ created: false, code: error?.code || "AUTOMATION_EVIDENCE_INVALID" }));
    process.exitCode = 1;
  }
}

import { collectAndUpload, readOnlySmoke } from "./core.js";

const CRON_HOUR_UTC = 22;
const CRON_MINUTE_UTC = 5;
const MAXIMUM_SCHEDULE_DELAY_MS = 6 * 60 * 60 * 1000;
const INTERNAL_GLOBAL_TIMEOUT_MS = 14 * 60 * 1000 + 30 * 1000;

function githubError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw githubError("GITHUB_CLOCK_INVALID");
  return date;
}

export function deriveScheduledAt(now = new Date()) {
  const observed = exactDate(now);
  let candidate = new Date(Date.UTC(
    observed.getUTCFullYear(),
    observed.getUTCMonth(),
    observed.getUTCDate(),
    CRON_HOUR_UTC,
    CRON_MINUTE_UTC,
    0,
    0,
  ));
  if (candidate.getTime() > observed.getTime()) candidate = new Date(candidate.getTime() - 24 * 60 * 60 * 1000);
  const delay = observed.getTime() - candidate.getTime();
  if (delay < 0 || delay > MAXIMUM_SCHEDULE_DELAY_MS) throw githubError("GITHUB_SCHEDULE_DELAY_INVALID");
  return candidate.toISOString();
}

function validateGithubRuntime(env = {}) {
  if (String(env.DMTG_GSC_COLLECTOR_RUNTIME || "").trim().toLowerCase() !== "github_actions") {
    throw githubError("GITHUB_RUNTIME_INVALID");
  }
}

async function withGlobalTimeout(operation, timeoutMs = INTERNAL_GLOBAL_TIMEOUT_MS) {
  const duration = Math.max(1, Math.min(INTERNAL_GLOBAL_TIMEOUT_MS, Number(timeoutMs) || INTERNAL_GLOBAL_TIMEOUT_MS));
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(githubError("GITHUB_GLOBAL_TIMEOUT"));
    }, duration);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function safeLog(log, event, summary) {
  const entry = {
    event,
    status: summary.status,
    startDate: summary.startDate,
    endDate: summary.endDate,
  };
  if (Number.isInteger(summary.rows)) entry.rows = summary.rows;
  if (Number.isInteger(summary.chunks)) entry.chunks = summary.chunks;
  if (Number.isInteger(summary.sampleRows)) entry.sampleRows = summary.sampleRows;
  log(entry);
}

export async function runScheduledCollection(env = {}, options = {}) {
  validateGithubRuntime(env);
  const eventName = String(options.githubEventName || process.env.GITHUB_EVENT_NAME || "");
  const githubRef = String(options.githubRef || process.env.GITHUB_REF || "");
  if (eventName !== "schedule" || githubRef !== "refs/heads/main") throw githubError("GITHUB_SCHEDULE_CONTEXT_INVALID");
  const observed = exactDate(options.now || new Date());
  const scheduledAt = deriveScheduledAt(observed);
  const log = typeof options.log === "function" ? options.log : (entry) => console.log(JSON.stringify(entry));
  const summary = await withGlobalTimeout((signal) => collectAndUpload(env, {
    ...options,
    now: new Date(scheduledAt),
    trigger: "scheduled",
    scheduledAt,
    signal,
    log: () => {},
  }), options.globalTimeoutMs);
  safeLog(log, "dmtg_gsc_github_scheduled", summary);
  return summary;
}

export async function runReadonlySmoke(env = {}, options = {}) {
  validateGithubRuntime(env);
  const log = typeof options.log === "function" ? options.log : (entry) => console.log(JSON.stringify(entry));
  const summary = await withGlobalTimeout((signal) => readOnlySmoke(env, {
    ...options,
    signal,
  }), options.globalTimeoutMs);
  safeLog(log, "dmtg_gsc_github_readonly", summary);
  return summary;
}

async function main() {
  const mode = String(process.argv[2] || "");
  const options = {
    githubEventName: process.env.GITHUB_EVENT_NAME,
    githubRef: process.env.GITHUB_REF,
  };
  if (mode === "scheduled") await runScheduledCollection(process.env, options);
  else if (mode === "readonly") await runReadonlySmoke(process.env, options);
  else throw githubError("GITHUB_MODE_INVALID");
}

if (import.meta.url === new URL(process.argv[1] || "", "file:").href) {
  main().catch((error) => {
    const safeCodes = new Set([
      "GITHUB_CLOCK_INVALID",
      "GITHUB_GLOBAL_TIMEOUT",
      "GITHUB_MODE_INVALID",
      "GITHUB_RUNTIME_INVALID",
      "GITHUB_SCHEDULE_CONTEXT_INVALID",
      "GITHUB_SCHEDULE_DELAY_INVALID",
      "GSC_HTTP_4XX",
      "GSC_HTTP_5XX",
      "GSC_JSON_INVALID",
      "GSC_NETWORK",
      "GSC_OAUTH_HTTP_4XX",
      "GSC_OAUTH_HTTP_5XX",
      "GSC_OAUTH_JSON_INVALID",
      "GSC_OAUTH_NETWORK",
      "GSC_OAUTH_TOKEN_MISSING",
      "GSC_SITE_NOT_VERIFIED",
      "INGEST_HTTP_4XX",
      "INGEST_HTTP_5XX",
      "INGEST_JSON_INVALID",
      "INGEST_NETWORK",
      "INGEST_RESPONSE_INVALID",
      "WORKER_CLOCK_INVALID",
      "WORKER_CONFIGURATION_MISSING",
      "WORKER_INGEST_URL_INVALID",
      "WORKER_OAUTH_SCOPE_INVALID",
      "WORKER_RUNTIME_UNSUPPORTED",
      "WORKER_SITE_INVALID",
    ]);
    console.error(JSON.stringify({ status: "failed", code: safeCodes.has(error?.code) ? error.code : "GITHUB_COLLECTOR_FAILED" }));
    process.exitCode = 1;
  });
}

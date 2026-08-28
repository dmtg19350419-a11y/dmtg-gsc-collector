import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const REQUIRED_FILES = Object.freeze(["manual-readonly.yml", "pr-verification.yml", "scheduled-collection.yml"]);
const REQUIRED_CHECKS = Object.freeze(["bundle-integrity", "collector-tests", "workflow-policy"]);
const ALLOWED_SCHEDULES = Object.freeze(["17 22 * * *", "47 6 * * *"]);

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function secretNames(text) {
  return [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
}

function exactSet(actual, expected, code) {
  if ([...new Set(actual)].sort().join("\n") !== [...expected].sort().join("\n")) throw policyError(code);
}

function occurrences(text, pattern) {
  return (text.match(pattern) || []).length;
}

function workflowHeader(text) {
  const jobsIndex = text.indexOf("\njobs:\n");
  if (jobsIndex < 0) throw policyError("WORKFLOW_POLICY_FILE_INVALID");
  return text.slice(0, jobsIndex);
}

function jobBlock(text, name, nextName = "") {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw policyError("WORKFLOW_POLICY_JOB_INVALID");
  const nextMarker = nextName ? `\n  ${nextName}:\n` : "";
  const end = nextMarker ? text.indexOf(nextMarker, start + marker.length) : text.length;
  if (nextMarker && end < 0) throw policyError("WORKFLOW_POLICY_JOB_INVALID");
  return text.slice(start, end);
}

function validateReadOnlyHeader(text) {
  const header = workflowHeader(text);
  if (!/\npermissions:\n  contents: read\n/.test(`\n${header}`) || /contents:\s*write/.test(header)) {
    throw policyError("WORKFLOW_POLICY_PERMISSION_INVALID");
  }
}

function validateCheckoutCredentials(text, expected) {
  const checkoutCount = occurrences(text, /uses:\s*actions\/checkout@/g);
  const persistedTrue = occurrences(text, /persist-credentials:\s*true/g);
  const persistedFalse = occurrences(text, /persist-credentials:\s*false/g);
  if (checkoutCount !== expected.count || persistedTrue !== expected.trueCount || persistedFalse !== expected.falseCount) {
    throw policyError("WORKFLOW_POLICY_PERMISSION_INVALID");
  }
}

function validateCommon(text) {
  if (/pull_request_target\s*:/.test(text)) throw policyError("WORKFLOW_POLICY_UNSAFE_EVENT");
  if (/uses:\s*[^\s]+\/[^\s]+\.(?:yml|yaml)@/i.test(text)) throw policyError("WORKFLOW_POLICY_REUSABLE_FORBIDDEN");
  if (/permissions:\s*(?:read-all|write-all)/.test(text)
      || /^\s+(?:actions|checks|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|security-events|statuses):\s*/m.test(text)
      || /secrets:\s*inherit|toJSON\s*\(\s*secrets\s*\)|\$\{\{\s*secrets\s*\}\}/i.test(text)) {
    throw policyError("WORKFLOW_POLICY_PERMISSION_INVALID");
  }
  for (const runner of [...text.matchAll(/runs-on:\s*([^\s#]+)/g)].map((match) => match[1])) {
    if (runner !== "ubuntu-24.04") throw policyError("WORKFLOW_POLICY_RUNNER_INVALID");
  }
  for (const action of [...text.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1])) {
    if (action !== `actions/checkout@${CHECKOUT_SHA}` && action !== `actions/setup-node@${SETUP_NODE_SHA}`) {
      throw policyError("WORKFLOW_POLICY_ACTION_INVALID");
    }
  }
  if (/actions\/(?:cache|upload-artifact|download-artifact)@/i.test(text) || /larger[-_ ]runner/i.test(text)) {
    throw policyError("WORKFLOW_POLICY_PAID_FEATURE_FORBIDDEN");
  }
}

export function validateWorkflowDirectory(directory) {
  const resolved = path.resolve(directory);
  const names = fs.readdirSync(resolved).filter((name) => /\.ya?ml$/i.test(name)).sort();
  exactSet(names, REQUIRED_FILES, "WORKFLOW_POLICY_FILE_SET_INVALID");
  const contents = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(resolved, name), "utf8")]));
  for (const text of Object.values(contents)) {
    validateCommon(text);
    validateReadOnlyHeader(text);
  }

  const pr = contents["pr-verification.yml"];
  if (!/^  pull_request:\s*$/m.test(pr) || /environment:|secrets\.|contents:\s*write/.test(pr)) throw policyError("WORKFLOW_POLICY_PR_INVALID");
  validateCheckoutCredentials(pr, { count: 3, trueCount: 0, falseCount: 3 });
  for (const check of REQUIRED_CHECKS) {
    if (!new RegExp(`^  ${check}:`, "m").test(pr)) throw policyError("WORKFLOW_POLICY_REQUIRED_CHECK_MISSING");
  }

  const manual = contents["manual-readonly.yml"];
  if (!/workflow_dispatch:\s*\n/.test(manual) || /\bschedule:\s*\n/.test(manual)
      || !manual.includes("environment: production-gsc") || manual.includes("INGEST_HMAC_SECRET")
      || /contents:\s*write/.test(manual)) throw policyError("WORKFLOW_POLICY_MANUAL_INVALID");
  validateCheckoutCredentials(manual, { count: 1, trueCount: 0, falseCount: 1 });
  exactSet(secretNames(manual), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"], "WORKFLOW_POLICY_MANUAL_SECRET_INVALID");

  const scheduled = contents["scheduled-collection.yml"];
  const collect = jobBlock(scheduled, "collect", "evidence");
  const evidence = jobBlock(scheduled, "evidence");
  const schedules = [...scheduled.matchAll(/cron:\s*'([^']+)'/g)].map((match) => match[1]);
  const guardedJobs = [collect, evidence].every((block) => block.includes("github.run_attempt == 1")
    && ALLOWED_SCHEDULES.every((schedule) => block.includes(`github.event.schedule == '${schedule}'`)));
  if (schedules.join("\n") !== ALLOWED_SCHEDULES.join("\n") || /workflow_dispatch:\s*\n/.test(scheduled)
      || !collect.includes("environment: production-gsc") || !collect.includes("timeout-minutes: 15")
      || !collect.includes("DMTG_GITHUB_SCHEDULE: ${{ github.event.schedule }}") || !guardedJobs
      || evidence.includes("environment:") || evidence.includes("secrets.") || evidence.includes("INGEST_HMAC_SECRET")
      || !evidence.includes("needs: collect")) throw policyError("WORKFLOW_POLICY_SCHEDULE_INVALID");
  if (!collect.includes("permissions:\n      contents: read") || collect.includes("contents: write")
      || !evidence.includes("permissions:\n      contents: write") || evidence.includes("contents: read")) {
    throw policyError("WORKFLOW_POLICY_PERMISSION_INVALID");
  }
  validateCheckoutCredentials(collect, { count: 1, trueCount: 0, falseCount: 1 });
  validateCheckoutCredentials(evidence, { count: 1, trueCount: 1, falseCount: 0 });
  exactSet(secretNames(scheduled), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "INGEST_HMAC_SECRET"], "WORKFLOW_POLICY_SCHEDULE_SECRET_INVALID");
  exactSet(secretNames(collect), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "INGEST_HMAC_SECRET"], "WORKFLOW_POLICY_SCHEDULE_SECRET_INVALID");
  exactSet(secretNames(evidence), [], "WORKFLOW_POLICY_SCHEDULE_SECRET_INVALID");
  if (occurrences(scheduled, /environment:\s*production-gsc/g) !== 1
      || occurrences(scheduled, /contents:\s*write/g) !== 1
      || occurrences(scheduled, /contents:\s*read/g) < 2) throw policyError("WORKFLOW_POLICY_PERMISSION_INVALID");

  return { ok: true, requiredChecks: [...REQUIRED_CHECKS] };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    console.log(JSON.stringify(validateWorkflowDirectory(process.argv[2] || ".github/workflows")));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error?.code || "WORKFLOW_POLICY_INVALID" }));
    process.exitCode = 1;
  }
}

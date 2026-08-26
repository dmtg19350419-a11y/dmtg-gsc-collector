import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_PUBLIC_FILES = Object.freeze([
  ".github/workflows/manual-readonly.yml",
  ".github/workflows/pr-verification.yml",
  ".github/workflows/scheduled-collection.yml",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "manifest.json",
  "package.json",
  "scripts/bundle-integrity.js",
  "scripts/validate-workflows.js",
  "scripts/write-automation-evidence.js",
  "src/core.js",
  "src/github.js",
  "test/collector.test.js",
]);

function bundleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function listFiles(root, current = root) {
  const result = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) throw bundleError("PUBLIC_BUNDLE_SYMLINK_FORBIDDEN");
    if (entry.isDirectory()) result.push(...listFiles(root, absolute));
    else if (entry.isFile()) result.push(relative);
    else throw bundleError("PUBLIC_BUNDLE_FILE_INVALID");
  }
  return result.sort();
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function scanSecrets(text) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /ya29\.[A-Za-z0-9._-]{20,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /sk-[A-Za-z0-9_-]{24,}/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw bundleError("PUBLIC_BUNDLE_SECRET_DETECTED");
}

export function verifyBundle(root = process.cwd()) {
  const resolved = path.resolve(root);
  const files = listFiles(resolved);
  if (files.join("\n") !== [...ALLOWED_PUBLIC_FILES].sort().join("\n")) throw bundleError("PUBLIC_BUNDLE_FILE_NOT_ALLOWED");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(resolved, "manifest.json"), "utf8")); } catch { throw bundleError("PUBLIC_BUNDLE_MANIFEST_INVALID"); }
  if (manifest?.schemaVersion !== 1 || manifest?.sourceRepository !== "codeup/quote-workbench"
      || !/^[a-f0-9]{40}$/.test(String(manifest?.sourceCommit || ""))) throw bundleError("PUBLIC_BUNDLE_MANIFEST_INVALID");
  const expectedManifestFiles = files.filter((file) => file !== "manifest.json");
  if (Object.keys(manifest.files || {}).sort().join("\n") !== expectedManifestFiles.join("\n")) throw bundleError("PUBLIC_BUNDLE_MANIFEST_INVALID");
  for (const relativePath of expectedManifestFiles) {
    const absolute = path.join(resolved, relativePath);
    if (manifest.files[relativePath] !== digest(absolute)) throw bundleError("PUBLIC_BUNDLE_DIGEST_MISMATCH");
    scanSecrets(fs.readFileSync(absolute, "utf8"));
  }
  return { ok: true, files };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const report = verifyBundle(process.argv[2] || process.cwd());
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error?.code || "PUBLIC_BUNDLE_INVALID" }));
    process.exitCode = 1;
  }
}

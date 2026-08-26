import assert from "node:assert/strict";
import { finalDateWindow, GOOGLE_SEARCH_CONSOLE_READ_SCOPE } from "../src/core.js";
import { deriveScheduledAt, runReadonlySmoke } from "../src/github.js";

function response(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

assert.equal(GOOGLE_SEARCH_CONSOLE_READ_SCOPE, "https://www.googleapis.com/auth/webmasters.readonly");
assert.equal(deriveScheduledAt(new Date("2026-08-26T01:05:00.000Z")), "2026-08-25T22:05:00.000Z");
assert.deepEqual(finalDateWindow(new Date("2026-08-25T22:05:00.000Z")), { startDate: "2026-08-19", endDate: "2026-08-22" });

const responses = [
  response(200, { access_token: "fixture-access-token" }),
  response(200, { siteEntry: [{ siteUrl: "sc-domain:dalianmachine.com", permissionLevel: "siteOwner" }] }),
  response(200, { rows: [] }),
];
const summary = await runReadonlySmoke({
  GOOGLE_CLIENT_ID: "fixture-client",
  GOOGLE_CLIENT_SECRET: "fixture-secret",
  GOOGLE_REFRESH_TOKEN: "fixture-refresh",
  GSC_SITE_URL: "sc-domain:dalianmachine.com",
  GOOGLE_OAUTH_SCOPE: GOOGLE_SEARCH_CONSOLE_READ_SCOPE,
  DMTG_GSC_COLLECTOR_RUNTIME: "github_actions",
}, {
  now: new Date("2026-08-25T22:05:00.000Z"),
  fetchImpl: async () => responses.shift(),
  sleepImpl: async () => {},
  log: () => {},
});
assert.deepEqual(summary, { status: "completed", siteVerified: true, sampleRows: 0, startDate: "2026-08-19", endDate: "2026-08-22" });

console.log("collector.test: ok");

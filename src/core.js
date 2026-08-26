export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_WEBMASTER_ENDPOINT = "https://www.googleapis.com/webmasters/v3";
export const DMTG_INGEST_URL = "https://www.dalianmachine.com/api/internal/dmtg/search-metrics/google";
export const DMTG_GSC_SITE_URL = "sc-domain:dalianmachine.com";
export const GOOGLE_SEARCH_CONSOLE_READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DIMENSIONS = Object.freeze(["date", "page", "query", "country", "device"]);
const DEFAULT_ROW_LIMIT = 2000;
const MAXIMUM_ROWS = 100000;
const IN_MEMORY_HELPER_ROWS = 5000;
const CHUNK_SIZE = 1000;
const CANONICAL_PAGE_PREFIX = "https://www.dalianmachine.com/";
export const COLLECTION_LIMITS = Object.freeze({
  rowLimit: DEFAULT_ROW_LIMIT,
  maximumRows: MAXIMUM_ROWS,
  inMemoryHelperRows: IN_MEMORY_HELPER_ROWS,
  collectionPasses: 2,
  maximumGscRequests: 100,
  maximumIngestRequests: 100,
  maximumBaseExternalRequests: 201,
  maximumExternalRequests: 603,
  maximumPageBytes: 2048,
  maximumQueryBytes: 1000,
  maximumRowJsonBytes: 4000,
  uploadIntervalMs: 600,
  requestTimeoutMs: 30000,
  retryLimit: 2,
});

function boundedError(code, status = 0) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function utf8(value) {
  return new TextEncoder().encode(String(value));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest("SHA-256", utf8(value)));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, utf8(value)));
}

function pacificDateParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function shiftedIsoDate(parts, days) {
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function finalDateWindow(now = new Date()) {
  const parts = pacificDateParts(now);
  return { startDate: shiftedIsoDate(parts, -6), endDate: shiftedIsoDate(parts, -3) };
}

export function buildSearchAnalyticsRequest({ startDate, endDate, startRow = 0, rowLimit = DEFAULT_ROW_LIMIT } = {}) {
  return {
    startDate,
    endDate,
    dimensions: [...DIMENSIONS],
    type: "web",
    aggregationType: "byPage",
    dataState: "final",
    rowLimit,
    startRow,
    dimensionFilterGroups: [{
      groupType: "and",
      filters: [{ dimension: "page", operator: "includingRegex", expression: "^https://www\\.dalianmachine\\.com/" }],
    }],
  };
}

async function safeJsonResponse(response, prefix) {
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    const category = status >= 500 ? "HTTP_5XX" : status >= 400 ? "HTTP_4XX" : "NETWORK";
    throw boundedError(`${prefix}_${category}`, status);
  }
  try {
    return await response.json();
  } catch {
    throw boundedError(`${prefix}_JSON_INVALID`, Number(response?.status || 0));
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let detach = () => {};
  if (parentSignal) {
    const abort = () => controller.abort();
    if (parentSignal.aborted) abort();
    else {
      parentSignal.addEventListener("abort", abort, { once: true });
      detach = () => parentSignal.removeEventListener("abort", abort);
    }
  }
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout);
      detach();
    },
  };
}

export async function requestJsonWithRetry({
  url,
  prefix,
  fetchImpl = fetch,
  requestFactory = () => ({}),
  retryLimit = COLLECTION_LIMITS.retryLimit,
  requestTimeoutMs = COLLECTION_LIMITS.requestTimeoutMs,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signal,
} = {}) {
  const attempts = Math.max(1, Math.min(3, (Number.isInteger(retryLimit) ? retryLimit : COLLECTION_LIMITS.retryLimit) + 1));
  const timeoutMs = Math.max(1, Math.min(COLLECTION_LIMITS.requestTimeoutMs, Number(requestTimeoutMs) || COLLECTION_LIMITS.requestTimeoutMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const init = await requestFactory(attempt);
    const scoped = requestSignal(signal, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: scoped.signal });
    } catch {
      scoped.close();
      if (attempt + 1 < attempts && !signal?.aborted) {
        await sleepImpl(250 * (attempt + 1));
        continue;
      }
      throw boundedError(`${prefix}_NETWORK`);
    }
    scoped.close();
    const status = Number(response?.status || 0);
    if (!response?.ok && isRetryableStatus(status) && attempt + 1 < attempts && !signal?.aborted) {
      try { await response.body?.cancel?.(); } catch { /* response content is intentionally discarded */ }
      await sleepImpl(250 * (attempt + 1));
      continue;
    }
    return safeJsonResponse(response, prefix);
  }
  throw boundedError(`${prefix}_NETWORK`);
}

function normalizeRow(row) {
  const keys = Array.isArray(row?.keys) ? row.keys : [];
  if (keys.length !== DIMENSIONS.length) throw boundedError("GSC_ROW_DIMENSIONS_INVALID");
  const rawPage = String(keys[1] || "");
  let page = rawPage;
  try { page = new URL(rawPage).href; } catch { /* noncanonical rows are filtered below */ }
  const query = String(keys[2] || "");
  if (utf8(page).byteLength > COLLECTION_LIMITS.maximumPageBytes || utf8(query).byteLength > COLLECTION_LIMITS.maximumQueryBytes) {
    throw boundedError("GSC_ROW_TEXT_BOUND_EXCEEDED");
  }
  const number = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw boundedError("GSC_ROW_METRIC_INVALID");
    return parsed;
  };
  const normalized = {
    date: String(keys[0] || ""),
    page,
    query,
    country: String(keys[3] || "").toLowerCase(),
    device: String(keys[4] || "").toLowerCase(),
    clicks: number(row.clicks),
    impressions: number(row.impressions),
    ctr: number(row.ctr),
    position: number(row.position),
  };
  if (isCanonicalPage(page) && utf8(JSON.stringify(normalized)).byteLength > COLLECTION_LIMITS.maximumRowJsonBytes) {
    throw boundedError("GSC_ROW_TEXT_BOUND_EXCEEDED");
  }
  return normalized;
}

function isCanonicalPage(pageValue) {
  try {
    const page = new URL(String(pageValue || ""));
    return page.origin === "https://www.dalianmachine.com" && page.href.startsWith(CANONICAL_PAGE_PREFIX) && !page.search && !page.hash;
  } catch {
    return false;
  }
}

async function scanSearchAnalytics({
  endpoint,
  accessToken,
  window,
  fetchImpl = fetch,
  rowLimit = DEFAULT_ROW_LIMIT,
  maximumRows = MAXIMUM_ROWS,
  onPage,
  retryLimit,
  requestTimeoutMs,
  sleepImpl,
  signal,
} = {}) {
  const pageLimit = Math.max(1, Math.min(DEFAULT_ROW_LIMIT, Number(rowLimit) || DEFAULT_ROW_LIMIT));
  const totalLimit = Math.max(1, Math.min(MAXIMUM_ROWS, Number(maximumRows) || MAXIMUM_ROWS));
  const pageDigests = [];
  let acceptedRows = 0;
  let sourceRows = 0;
  let lastPageFull = false;
  for (let startRow = 0; startRow < totalLimit; startRow += pageLimit) {
    const payload = await requestJsonWithRetry({
      url: endpoint,
      prefix: "GSC",
      fetchImpl,
      retryLimit,
      requestTimeoutMs,
      sleepImpl,
      signal,
      requestFactory: () => ({
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildSearchAnalyticsRequest({ ...window, startRow, rowLimit: pageLimit })),
      }),
    });
    const pageRows = Array.isArray(payload.rows) ? payload.rows : [];
    if (pageRows.length > pageLimit) throw boundedError("GSC_PAGE_BOUND_EXCEEDED");
    sourceRows += pageRows.length;
    lastPageFull = pageRows.length === pageLimit;
    const normalizedRows = pageRows.map(normalizeRow).filter((row) => isCanonicalPage(row.page));
    const pageDigest = await sha256Hex(JSON.stringify(normalizedRows));
    pageDigests.push(pageDigest);
    acceptedRows += normalizedRows.length;
    if (typeof onPage === "function") await onPage(normalizedRows, { startRow, pageIndex: pageDigests.length - 1, pageDigest });
    if (pageRows.length < pageLimit) break;
  }
  return {
    rows: acceptedRows,
    sourceRows,
    pages: pageDigests.length,
    pageDigests,
    capReached: lastPageFull && sourceRows >= totalLimit,
  };
}

export async function collectSearchAnalytics({ endpoint, accessToken, window, fetchImpl = fetch, rowLimit = DEFAULT_ROW_LIMIT, maximumRows = IN_MEMORY_HELPER_ROWS, retryLimit, requestTimeoutMs, sleepImpl, signal } = {}) {
  const helperLimit = Math.max(1, Math.min(IN_MEMORY_HELPER_ROWS, Number(maximumRows) || IN_MEMORY_HELPER_ROWS));
  const rows = [];
  await scanSearchAnalytics({ endpoint, accessToken, window, fetchImpl, rowLimit, maximumRows: helperLimit, retryLimit, requestTimeoutMs, sleepImpl, signal, onPage: async (pageRows) => { rows.push(...pageRows); } });
  return rows;
}

async function accessToken(env, options = {}) {
  const payload = await requestJsonWithRetry({
    url: GOOGLE_TOKEN_ENDPOINT,
    prefix: "GSC_OAUTH",
    fetchImpl: options.fetchImpl,
    retryLimit: options.retryLimit,
    requestTimeoutMs: options.requestTimeoutMs,
    sleepImpl: options.sleepImpl,
    signal: options.signal,
    requestFactory: () => ({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }).toString(),
    }),
  });
  const token = String(payload.access_token || "");
  if (!token) throw boundedError("GSC_OAUTH_TOKEN_MISSING");
  return token;
}

function validatedGoogleEnvironment(env = {}, { requireIngest = false } = {}) {
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!String(env[name] || "")) throw boundedError("WORKER_CONFIGURATION_MISSING");
  }
  const siteUrl = String(env.GSC_SITE_URL || "");
  if (siteUrl !== DMTG_GSC_SITE_URL) throw boundedError("WORKER_SITE_INVALID");
  if (String(env.GOOGLE_OAUTH_SCOPE || "") !== GOOGLE_SEARCH_CONSOLE_READ_SCOPE) throw boundedError("WORKER_OAUTH_SCOPE_INVALID");
  const runtime = String(env.DMTG_GSC_COLLECTOR_RUNTIME || "").trim().toLowerCase();
  if (!new Set(["cloudflare", "github_actions"]).has(runtime)) throw boundedError("WORKER_RUNTIME_UNSUPPORTED");
  if (!requireIngest) return { siteUrl, runtime };
  if (String(env.INGEST_HMAC_SECRET || "").length < 32) throw boundedError("WORKER_CONFIGURATION_MISSING");
  const ingestUrlText = String(env.INGEST_URL || "");
  let ingestUrl;
  try { ingestUrl = new URL(ingestUrlText); } catch { throw boundedError("WORKER_INGEST_URL_INVALID"); }
  if (ingestUrlText !== DMTG_INGEST_URL || ingestUrl.href !== DMTG_INGEST_URL) throw boundedError("WORKER_INGEST_URL_INVALID");
  return { siteUrl, ingestUrl: ingestUrl.href, runtime };
}

export async function readOnlySmoke(env, options = {}) {
  const configuration = validatedGoogleEnvironment(env);
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = typeof options.sleepImpl === "function" ? options.sleepImpl : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const network = {
    fetchImpl,
    retryLimit: options.retryLimit,
    requestTimeoutMs: options.requestTimeoutMs,
    sleepImpl,
    signal: options.signal,
  };
  const token = await accessToken(env, network);
  const sites = await requestJsonWithRetry({
    url: `${GOOGLE_WEBMASTER_ENDPOINT}/sites`,
    prefix: "GSC",
    ...network,
    requestFactory: () => ({ headers: { Authorization: `Bearer ${token}` } }),
  });
  const siteVerified = Array.isArray(sites.siteEntry) && sites.siteEntry.some((entry) => entry?.siteUrl === configuration.siteUrl);
  if (!siteVerified) throw boundedError("GSC_SITE_NOT_VERIFIED");
  const now = new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw boundedError("WORKER_CLOCK_INVALID");
  const window = finalDateWindow(now);
  const endpoint = `${GOOGLE_WEBMASTER_ENDPOINT}/sites/${encodeURIComponent(configuration.siteUrl)}/searchAnalytics/query`;
  const rows = await collectSearchAnalytics({ endpoint, accessToken: token, window, ...network, rowLimit: 1, maximumRows: 1 });
  return { status: "completed", siteVerified: true, sampleRows: rows.length, startDate: window.startDate, endDate: window.endDate };
}

export async function signIngestBody(rawBody, secret, { timestamp, nonce, trigger, scheduledAt } = {}) {
  if (trigger !== "scheduled") throw boundedError("WORKER_TRIGGER_INVALID");
  const scheduledDate = new Date(scheduledAt);
  if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate.toISOString() !== scheduledAt) throw boundedError("WORKER_TRIGGER_INVALID");
  const bodyHash = await sha256Hex(rawBody);
  const signature = await hmacHex(secret, `${timestamp}\n${nonce}\n${trigger}\n${scheduledAt}\n${bodyHash}`);
  return {
    "Content-Type": "application/json",
    "X-DMTG-Ingest-Timestamp": String(timestamp),
    "X-DMTG-Ingest-Nonce": String(nonce),
    "X-DMTG-Worker-Trigger": trigger,
    "X-DMTG-Worker-Scheduled-Time": scheduledAt,
    "X-DMTG-Ingest-Body-SHA256": bodyHash,
    "X-DMTG-Ingest-Signature": signature,
  };
}

export async function collectAndUpload(env, options = {}) {
  const configuration = validatedGoogleEnvironment(env, { requireIngest: true });
  const now = new Date(options.now || Date.now());
  const trigger = options.trigger || "scheduled";
  const scheduledAt = options.scheduledAt || now.toISOString();
  const scheduledDate = new Date(scheduledAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(scheduledDate.getTime()) || scheduledDate.toISOString() !== scheduledAt) throw boundedError("WORKER_CLOCK_INVALID");
  const fetchImpl = options.fetchImpl || fetch;
  const requestNow = typeof options.requestNow === "function" ? options.requestNow : () => Date.now();
  const sleepImpl = typeof options.sleepImpl === "function" ? options.sleepImpl : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const log = typeof options.log === "function" ? options.log : (entry) => console.log(JSON.stringify(entry));
  const network = {
    fetchImpl,
    retryLimit: options.retryLimit,
    requestTimeoutMs: options.requestTimeoutMs,
    sleepImpl,
    signal: options.signal,
  };
  const window = finalDateWindow(scheduledDate);
  const token = await accessToken(env, network);
  const endpoint = `${GOOGLE_WEBMASTER_ENDPOINT}/sites/${encodeURIComponent(configuration.siteUrl)}/searchAnalytics/query`;
  const manifest = await scanSearchAnalytics({ endpoint, accessToken: token, window, ...network, rowLimit: DEFAULT_ROW_LIMIT, maximumRows: MAXIMUM_ROWS });
  const siteDigest = (await sha256Hex(configuration.siteUrl)).slice(0, 12);
  const rowsDigest = (await sha256Hex(manifest.pageDigests.join("\n"))).slice(0, 12);
  const runId = `gsc-${window.startDate}-${window.endDate}-${siteDigest}-${rowsDigest}`;
  const chunkCount = Math.max(1, Math.ceil(manifest.rows / CHUNK_SIZE));
  let chunkIndex = 0;
  let remoteCompleted = false;
  const uploadChunk = async (chunkRows) => {
    if (remoteCompleted) {
      chunkIndex += 1;
      return;
    }
    const body = {
      schemaVersion: 1,
      source: "google_search_console",
      runId,
      siteUrl: configuration.siteUrl,
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: [...DIMENSIONS],
      chunkIndex,
      chunkCount,
      totalRows: manifest.rows,
      rows: chunkRows,
    };
    const rawBody = JSON.stringify(body);
    const ingestResult = await requestJsonWithRetry({
      url: configuration.ingestUrl,
      prefix: "INGEST",
      ...network,
      requestFactory: async (attempt) => {
        const signingTime = new Date(requestNow(chunkIndex, attempt));
        if (!Number.isFinite(signingTime.getTime())) throw boundedError("WORKER_CLOCK_INVALID");
        const timestamp = Math.floor(signingTime.getTime() / 1000);
        const nonce = typeof options.nonceFactory === "function" ? options.nonceFactory(chunkIndex, attempt) : crypto.randomUUID();
        const headers = await signIngestBody(rawBody, env.INGEST_HMAC_SECRET, { timestamp, nonce, trigger, scheduledAt });
        return { method: "POST", headers, body: rawBody };
      },
    });
    const finalChunk = chunkIndex === chunkCount - 1;
    const accepted = ingestResult?.ok === true && ingestResult?.runId === runId && ingestResult?.status === "accepted"
      && Number.isInteger(ingestResult?.receivedChunks) && Number.isInteger(ingestResult?.expectedChunks)
      && ingestResult.expectedChunks === chunkCount && ingestResult.receivedChunks >= chunkIndex + 1
      && ingestResult.receivedChunks < chunkCount;
    const completed = ingestResult?.ok === true && ingestResult?.runId === runId && ingestResult?.status === "completed"
      && Number(ingestResult?.rows) === manifest.rows;
    if ((!accepted && !completed) || (finalChunk && !completed)) throw boundedError("INGEST_RESPONSE_INVALID");
    if (completed) remoteCompleted = true;
    chunkIndex += 1;
    if (chunkIndex < chunkCount) await sleepImpl(COLLECTION_LIMITS.uploadIntervalMs);
  };

  const collectionPasses = 2;
  let streamedRows = 0;
  let bufferedRows = [];
  const uploadScan = await scanSearchAnalytics({
    endpoint,
    accessToken: token,
    window,
    ...network,
    rowLimit: DEFAULT_ROW_LIMIT,
    maximumRows: MAXIMUM_ROWS,
    onPage: async (pageRows, page) => {
      if (manifest.pageDigests[page.pageIndex] !== page.pageDigest) throw boundedError("GSC_SNAPSHOT_CHANGED");
      streamedRows += pageRows.length;
      if (streamedRows > manifest.rows) throw boundedError("GSC_SNAPSHOT_CHANGED");
      bufferedRows.push(...pageRows);
      while (bufferedRows.length > CHUNK_SIZE) {
        await uploadChunk(bufferedRows.slice(0, CHUNK_SIZE));
        bufferedRows = bufferedRows.slice(CHUNK_SIZE);
      }
    },
  });
  if (uploadScan.rows !== manifest.rows || uploadScan.pages !== manifest.pages
      || uploadScan.pageDigests.some((digest, index) => digest !== manifest.pageDigests[index])) {
    throw boundedError("GSC_SNAPSHOT_CHANGED");
  }
  await uploadChunk(bufferedRows);
  if (chunkIndex !== chunkCount) throw boundedError("GSC_SNAPSHOT_CHANGED");
  if (!remoteCompleted) throw boundedError("INGEST_RESPONSE_INVALID");
  const summary = {
    status: "completed",
    rows: manifest.rows,
    sourceRows: manifest.sourceRows,
    chunks: chunkCount,
    collectionPasses,
    rowCapReached: manifest.capReached,
    coverage: "search_console_top_rows_bounded_100000",
    startDate: window.startDate,
    endDate: window.endDate,
    trigger,
    scheduledAt,
  };
  log({ event: "dmtg_gsc_collection", ...summary });
  return summary;
}

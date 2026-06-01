const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");
const imageInput = document.getElementById("image");
const convertForm = document.getElementById("convert-form");
const convertStatusMessage = document.getElementById("convert-status");
const resultContainer = document.getElementById("result");
const uploadResultContainer = document.getElementById("upload-result");

const PERSISTENCE_KEY = "likha-pdf:form-state:v1";
const SESSION_IMAGE_CACHE_KEY = "likha-pdf:session-images:v1";
const PDF_FILENAME_KEY = "likha-pdf:last-pdf-filename";
const SNIPPET_DETAILS_OPEN_KEY = "likha-pdf:snippet-details-open:v1";
const SESSION_IMAGE_SCHEME = "session-image://";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_CONVERT_REQUEST_BYTES = 2048 * 1024 * 1024;
const ALLOWED_IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|svg)$/i;
const TAB_SPACES = "    ";

let snippetDetailsIsOpen = readPersistedBoolean(SNIPPET_DETAILS_OPEN_KEY, false);
let sessionImageCache = readSessionImageCache();

function readPersistedState() {
  try {
    const raw = localStorage.getItem(PERSISTENCE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePersistedState(value) {
  try {
    localStorage.setItem(PERSISTENCE_KEY, JSON.stringify(value));
  } catch {
    // ignore persistence failures in restricted storage contexts
  }
}

function readPersistedBoolean(key, fallback = false) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writePersistedBoolean(key, value) {
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore persistence failures in restricted storage contexts
  }
}

function setSnippetDetailsOpen(isOpen) {
  snippetDetailsIsOpen = Boolean(isOpen);
  writePersistedBoolean(SNIPPET_DETAILS_OPEN_KEY, snippetDetailsIsOpen);
}

function collectFormState() {
  if (!(convertForm instanceof HTMLFormElement)) {
    return;
  }

  const fields = {};
  const elements = Array.from(convertForm.elements);

  for (const element of elements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const name = element.getAttribute("name");
    if (!name || name === "markdown") {
      continue;
    }

    if (element instanceof HTMLInputElement) {
      if (element.type === "radio") {
        if (element.checked) {
          fields[name] = element.value;
        }
      } else if (element.type === "checkbox") {
        fields[name] = element.checked;
      }
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      fields[name] = element.value;
    }
  }

  writePersistedState({
    markdown: markdownInput?.value ?? "",
    fields,
  });
}

function restoreFormState() {
  if (!(convertForm instanceof HTMLFormElement)) {
    return;
  }

  const state = readPersistedState();
  if (!state || typeof state !== "object") {
    return;
  }

  if (markdownInput && typeof state.markdown === "string") {
    markdownInput.value = state.markdown;
    markdownInput.readOnly = false;
  }

  if (imageInput) {
    imageInput.disabled = false;
  }

  if (uploadButton) {
    uploadButton.disabled = false;
  }

  const fields = state.fields;
  if (!fields || typeof fields !== "object") {
    return;
  }

  for (const [name, value] of Object.entries(fields)) {
    const element = convertForm.elements.namedItem(name);
    if (!element) {
      continue;
    }

    if (element instanceof RadioNodeList) {
      element.value = String(value);
      continue;
    }

    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      element.checked = Boolean(value);
      continue;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      element.value = String(value);
    }
  }
}

function setConvertLoadingState(isLoading) {
  if (convertButton instanceof HTMLButtonElement) {
    convertButton.disabled = isLoading;
    convertButton.textContent = isLoading ? "generating..." : "generate pdf";
  }

  if (convertStatusMessage instanceof HTMLElement) {
    convertStatusMessage.hidden = !isLoading;
  }
}

function setUploadLoadingState(isLoading) {
  if (uploadButton instanceof HTMLButtonElement) {
    uploadButton.disabled = isLoading;
    uploadButton.textContent = isLoading ? "uploading..." : "insert image";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(numBytes) {
  const parsed = Number(numBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "0 B";
  }

  if (parsed < 1024) {
    return `${Math.round(parsed)} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = parsed;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024) {
      return `${value.toFixed(2)} ${unit}`;
    }
  }

  return `${value.toFixed(2)} PB`;
}

function buildSessionImageSnippet(name, id) {
  const cleanName = String(name || "image").replace(/[\]\r\n]/g, "");
  return `![${cleanName}](${SESSION_IMAGE_SCHEME}${id})`;
}

function normalizeImageRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return null;
  }

  const nameValue = typeof raw.name === "string" ? raw.name.trim() : "";
  const name = nameValue || "image";

  const mimeValue = typeof raw.mimeType === "string" ? raw.mimeType.trim() : "";
  const mimeType = mimeValue || "application/octet-stream";

  const sizeValue = Number(raw.sizeBytes);
  const sizeBytes = Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0;

  const createdAtValue = Number(raw.createdAt);
  const createdAt = Number.isFinite(createdAtValue) && createdAtValue > 0
    ? createdAtValue
    : Date.now();

  const snippetValue = typeof raw.snippet === "string" ? raw.snippet.trim() : "";
  const snippet = snippetValue || buildSessionImageSnippet(name, id);

  return {
    id,
    name,
    mimeType,
    sizeBytes,
    createdAt,
    snippet,
  };
}

function dedupeImageRecords(records) {
  const deduped = [];
  const seen = new Set();

  for (const record of records) {
    if (!record || seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    deduped.push(record);
  }

  return deduped;
}

function sortImageRecordsByCreatedAt(records) {
  return [...records].sort((a, b) => b.createdAt - a.createdAt);
}

function toCacheImageRecord(record) {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    snippet: record.snippet,
  };
}

function readSessionImageCache() {
  try {
    const raw = sessionStorage.getItem(SESSION_IMAGE_CACHE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed
      .map(normalizeImageRecord)
      .filter((record) => record !== null);

    return dedupeImageRecords(normalized);
  } catch {
    return [];
  }
}

function writeSessionImageCache(records) {
  try {
    const payload = records.map(toCacheImageRecord);
    sessionStorage.setItem(SESSION_IMAGE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage write failures in restricted storage contexts
  }
}

function setSessionImageCache(records) {
  const normalized = records
    .map(normalizeImageRecord)
    .filter((record) => record !== null);

  sessionImageCache = dedupeImageRecords(normalized);
  writeSessionImageCache(sessionImageCache);
}

function getSessionImageCache() {
  return [...sessionImageCache];
}

function mergeImageRecordsCachedFirst(cachedRecords, serverRecords) {
  const normalizedCache = dedupeImageRecords(
    cachedRecords.map(normalizeImageRecord).filter((record) => record !== null)
  );

  const normalizedServer = sortImageRecordsByCreatedAt(
    dedupeImageRecords(
      serverRecords.map(normalizeImageRecord).filter((record) => record !== null)
    )
  );

  const serverById = new Map(normalizedServer.map((record) => [record.id, record]));
  const mergedCache = normalizedCache.map((cachedRecord) => ({
    ...(serverById.get(cachedRecord.id) || {}),
    ...cachedRecord,
  }));

  const cacheIds = new Set(mergedCache.map((record) => record.id));
  const serverOnly = normalizedServer.filter((record) => !cacheIds.has(record.id));

  return [...mergedCache, ...serverOnly];
}

function upsertSessionImageCache(record) {
  const normalized = normalizeImageRecord(record);
  if (!normalized) {
    return null;
  }

  const withoutRecord = sessionImageCache.filter((entry) => entry.id !== normalized.id);
  setSessionImageCache([normalized, ...withoutRecord]);
  return normalized;
}

function insertSnippetIntoMarkdown(snippet) {
  if (!markdownInput) {
    return;
  }

  const needsLeadingNewline = markdownInput.value && !markdownInput.value.endsWith("\n");
  const prefix = needsLeadingNewline ? "\n" : "";
  markdownInput.value += `${prefix}${snippet}\n`;
  markdownInput.focus();
  collectFormState();
}

function isAllowedImageFile(file) {
  if (file.type.startsWith("image/")) {
    return true;
  }

  return ALLOWED_IMAGE_EXT_PATTERN.test(file.name || "");
}

function randomHex(length = 40) {
  const byteLen = Math.ceil(length / 2);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(byteLen);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, length);
  }

  let out = "";
  while (out.length < length) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, length);
}

function renderSnippetHistory(records, heading = "", message = "") {
  if (!(uploadResultContainer instanceof HTMLElement)) {
    return;
  }

  if (records.length === 0 && !heading && !message) {
    uploadResultContainer.innerHTML = "";
    return;
  }

  const headingHtml = heading ? `<h4>${escapeHtml(heading)}</h4>` : "";
  const messageHtml = message ? `<p>${escapeHtml(message)}</p>` : "";

  let detailsHtml = "";
  if (records.length > 0) {
    const openAttr = snippetDetailsIsOpen ? " open" : "";
    const detailsItems = records
      .map((record) => {
        const sizeText = formatBytes(record.sizeBytes);
        return `
          <li style="all: revert; margin-bottom: 0.6em;">
            <div style="all: revert;">
              <strong style="all: revert;">${escapeHtml(record.name)}</strong>
              <small style="all: revert; color: #555;">${escapeHtml(sizeText)}</small>
            </div>
            <code style="all: revert; display: inline-block; margin-top: 0.2em;">${escapeHtml(record.snippet)}</code>
          </li>
        `;
      })
      .join("");

    detailsHtml = `
      <br>
      <details style="all: revert;" data-snippet-history="true"${openAttr}>
        <summary style="all: revert; cursor: pointer;">images (${records.length})</summary>
        <ol style="all: revert;">${detailsItems}</ol>
      </details>
      <br>
    `;
  }

  uploadResultContainer.innerHTML = `
    <article>
      ${headingHtml}
      ${messageHtml}
      ${detailsHtml}
    </article>
  `;

  const renderedDetails = uploadResultContainer.querySelector(
    'details[data-snippet-history="true"]'
  );
  if (renderedDetails instanceof HTMLDetailsElement) {
    renderedDetails.addEventListener("toggle", () => {
      setSnippetDetailsOpen(renderedDetails.open);
    });
  }
}

async function readApiError(response, fallbackMessage) {
  const fallback = String(fallbackMessage || "request failed.");
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      const errorText = payload && typeof payload.error === "string" ? payload.error : "";
      if (errorText.trim()) {
        return errorText.trim();
      }
    } catch {
      // ignore json parse failures
    }
    return fallback;
  }

  try {
    const text = (await response.text()).trim();
    if (text) {
      return text.slice(0, 1200);
    }
  } catch {
    // ignore body read failures
  }

  return fallback;
}

async function syncSessionImageCacheFromServer() {
  const response = await fetch("/session-images", {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      await readApiError(response, `failed to load session images (${response.status}).`)
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const serverRecordsRaw = Array.isArray(payload?.images) ? payload.images : [];
  const merged = mergeImageRecordsCachedFirst(getSessionImageCache(), serverRecordsRaw);
  setSessionImageCache(merged);
  return getSessionImageCache();
}

async function refreshSnippetHistory(heading = "", message = "") {
  renderSnippetHistory(getSessionImageCache(), heading, message);

  try {
    const mergedRecords = await syncSessionImageCacheFromServer();
    renderSnippetHistory(mergedRecords, heading, message);
  } catch {
    // keep the cache view when server sync fails
  }
}

function showUploadError(message) {
  void refreshSnippetHistory("image upload failed", message);
}

async function showUploadResult(record) {
  insertSnippetIntoMarkdown(record.snippet);
  await refreshSnippetHistory("image inserted", record.name || "image");
}

async function handleInsertImage() {
  if (!(imageInput instanceof HTMLInputElement)) {
    return;
  }

  const file = imageInput.files?.[0];
  if (!file) {
    showUploadError("image file is required.");
    return;
  }

  if (!isAllowedImageFile(file)) {
    showUploadError("unsupported image type.");
    return;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    showUploadError("image is too large. maximum size per image is 25MB.");
    return;
  }

  setUploadLoadingState(true);

  try {
    const uploadFormData = new FormData();
    uploadFormData.set("image", file, file.name || "image");

    const response = await fetch("/upload-image", {
      method: "POST",
      body: uploadFormData,
    });

    if (!response.ok) {
      showUploadError(
        await readApiError(response, `image upload failed (${response.status}).`)
      );
      return;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const uploadedRecord = upsertSessionImageCache(payload?.image || null);
    if (!uploadedRecord) {
      showUploadError("image upload failed.");
      return;
    }

    await showUploadResult(uploadedRecord);
    imageInput.value = "";
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "image upload failed.";
    showUploadError(message);
  } finally {
    setUploadLoadingState(false);
  }
}

function showConvertError(message) {
  if (!(resultContainer instanceof HTMLElement)) {
    return;
  }

  resultContainer.innerHTML = `
    <article>
      <h3>Conversion failed</h3>
      <pre>${escapeHtml(message)}</pre>
    </article>
  `;
  resultContainer.scrollIntoView({ behavior: "smooth", block: "start" });
}

let activePdfUrl = "";

function clearActivePdfUrl() {
  if (activePdfUrl) {
    URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = "";
  }
}

function clearPersistedPdfFilename() {
  try {
    localStorage.removeItem(PDF_FILENAME_KEY);
  } catch {
    // ignore storage write failures
  }
}

function clearReadyPdfResult() {
  if (!(resultContainer instanceof HTMLElement)) {
    return;
  }

  const readyLink = resultContainer.querySelector("a[download]");
  if (readyLink) {
    resultContainer.innerHTML = "";
  }
}

function prepareForPdfRegeneration() {
  clearActivePdfUrl();
  clearPersistedPdfFilename();
  clearReadyPdfResult();
}

function sanitizeDownloadFilename(filename) {
  const epoch = Math.floor(Date.now() / 1000);
  const fallback = `likha-pdf_${epoch}_${randomHex(40)}.pdf`;
  if (!filename) {
    return fallback;
  }

  const sanitized = filename.replaceAll(/[^a-zA-Z0-9._()\- ]/g, "_").trim();
  return sanitized || fallback;
}

function getDownloadFilenameFromResponse(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return sanitizeDownloadFilename(decodeURIComponent(utf8Match[1]));
    } catch {
      return sanitizeDownloadFilename(utf8Match[1]);
    }
  }

  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    return sanitizeDownloadFilename(plainMatch[1]);
  }

  return sanitizeDownloadFilename("");
}

function showPdfReady(pdfBlob, downloadFilename) {
  if (!(resultContainer instanceof HTMLElement)) {
    return;
  }

  try {
    localStorage.setItem(PDF_FILENAME_KEY, downloadFilename);
  } catch {
    // ignore storage write failures
  }

  clearActivePdfUrl();
  activePdfUrl = URL.createObjectURL(pdfBlob);

  resultContainer.innerHTML = `
    <article>
      <h3>pdf ready</h3>
      <a href="${escapeHtml(activePdfUrl)}" download="${escapeHtml(downloadFilename)}">download pdf</a>
    </article>
  `;
  resultContainer.scrollIntoView({ behavior: "smooth", block: "start" });
}

function extractErrorMessageFromResponseHtml(html, fallbackMessage = "failed to generate pdf.") {
  const fallback = String(fallbackMessage || "failed to generate pdf.");
  if (!html) {
    return fallback;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const preText = doc.querySelector("pre")?.textContent?.trim();
    if (preText) {
      return preText;
    }

    const articleText = doc.querySelector("article")?.textContent?.trim();
    if (articleText) {
      return articleText;
    }

    const bodyText = doc.body?.textContent?.trim();
    if (bodyText) {
      return bodyText;
    }
  } catch {
    // ignore parser failures
  }

  const plain = String(html).replace(/\s+/g, " ").trim();
  if (!plain) {
    return fallback;
  }

  return plain.slice(0, 1200);
}

async function handleConvertSubmit(event) {
  event.preventDefault();

  if (!(convertForm instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(convertForm);
  const markdownValue = formData.get("markdown");
  const markdown = typeof markdownValue === "string" ? markdownValue : "";

  if (!markdown.trim()) {
    showConvertError("Markdown content is required.");
    return;
  }

  const markdownBytes = new Blob([markdown]).size;
  if (markdownBytes > MAX_CONVERT_REQUEST_BYTES) {
    showConvertError(
      "markdown is too large to send for conversion. reduce image usage or increase server limits."
    );
    return;
  }

  setConvertLoadingState(true);
  prepareForPdfRegeneration();

  try {
    const response = await fetch("/convert", {
      method: "POST",
      body: formData,
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (response.ok && contentType.includes("application/pdf")) {
      const pdfBlob = await response.blob();
      const downloadFilename = getDownloadFilenameFromResponse(response);
      showPdfReady(pdfBlob, downloadFilename);
      return;
    }

    const responseHtml = await response.text();
    showConvertError(
      extractErrorMessageFromResponseHtml(
        responseHtml,
        `conversion failed (${response.status})`
      )
    );
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "failed to generate pdf.";
    showConvertError(message);
  } finally {
    setConvertLoadingState(false);
  }
}

function handleMarkdownTabKeydown(event) {
  if (!(markdownInput instanceof HTMLTextAreaElement)) {
    return;
  }

  if (
    event.key !== "Tab" ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.defaultPrevented
  ) {
    return;
  }

  event.preventDefault();

  const selectionStart = markdownInput.selectionStart ?? 0;
  const selectionEnd = markdownInput.selectionEnd ?? selectionStart;
  markdownInput.value =
    markdownInput.value.slice(0, selectionStart) +
    TAB_SPACES +
    markdownInput.value.slice(selectionEnd);

  const caretPosition = selectionStart + TAB_SPACES.length;
  markdownInput.selectionStart = caretPosition;
  markdownInput.selectionEnd = caretPosition;

  collectFormState();
}

restoreFormState();

if (markdownInput instanceof HTMLTextAreaElement) {
  markdownInput.addEventListener("keydown", handleMarkdownTabKeydown);
}

if (convertForm instanceof HTMLFormElement) {
  convertForm.addEventListener("input", collectFormState);
  convertForm.addEventListener("change", collectFormState);
  convertForm.addEventListener("submit", (event) => {
    void handleConvertSubmit(event);
  });
}

if (uploadButton instanceof HTMLButtonElement) {
  uploadButton.addEventListener("click", () => {
    void handleInsertImage();
  });
}

void refreshSnippetHistory();

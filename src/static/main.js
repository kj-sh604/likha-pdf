const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");
const imageInput = document.getElementById("image");
const convertForm = document.getElementById("convert-form");
const convertStatusMessage = document.getElementById("convert-status");
const resultContainer = document.getElementById("result");
const uploadResultContainer = document.getElementById("upload-result");

const PERSISTENCE_KEY = "likha-pdf:form-state:v1";
const IMAGE_DB_NAME = "likha-pdf:image-db:v1";
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = "images";
const PDF_FILENAME_KEY = "likha-pdf:last-pdf-filename";
const SNIPPET_DETAILS_OPEN_KEY = "likha-pdf:snippet-details-open:v1";
const LOCAL_IMAGE_SCHEME = "local-image://";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_STORAGE_BYTES = 25 * 1024 * 1024 * 1024;
const MAX_CONVERT_REQUEST_BYTES = 512 * 1024 * 1024;
const LOCAL_IMAGE_TOKEN_PATTERN = /local-image:\/\/([a-zA-Z0-9-]+)/g;
const ALLOWED_IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|svg)$/i;
let snippetDetailsIsOpen = readPersistedBoolean(SNIPPET_DETAILS_OPEN_KEY, false);

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

    if (
      element instanceof HTMLInputElement &&
      element.type === "checkbox"
    ) {
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
    uploadButton.textContent = isLoading ? "preparing..." : "insert image";
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildLocalImageSnippet(name, id) {
  const cleanName = String(name || "image").replace(/[\]\r\n]/g, "");
  return `![${cleanName}](${LOCAL_IMAGE_SCHEME}${id})`;
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

function makeImageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `img-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
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

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("indexeddb transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("indexeddb transaction aborted"));
  });
}

function openImageDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        db.createObjectStore(IMAGE_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("failed to open indexeddb"));
  });
}

async function saveImageRecord(record) {
  const db = await openImageDb();

  try {
    const transaction = db.transaction(IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(IMAGE_STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

async function getImageRecord(imageId) {
  const db = await openImageDb();

  try {
    const transaction = db.transaction(IMAGE_STORE_NAME, "readonly");
    const request = transaction.objectStore(IMAGE_STORE_NAME).get(imageId);
    const record = await requestToPromise(request);
    await transactionDone(transaction);
    return record;
  } finally {
    db.close();
  }
}

async function getImageUsageStats() {
  const db = await openImageDb();

  try {
    const transaction = db.transaction(IMAGE_STORE_NAME, "readonly");
    const store = transaction.objectStore(IMAGE_STORE_NAME);

    let count = 0;
    let totalBytes = 0;

    await new Promise((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }

        count += 1;
        let sizeBytes = Number(cursor.value?.sizeBytes);
        if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
          sizeBytes = Number(cursor.value?.blob?.size) || 0;
        }
        totalBytes += sizeBytes;
        cursor.continue();
      };

      request.onerror = () => reject(request.error || new Error("failed to read image usage"));
    });

    await transactionDone(transaction);
    return { count, totalBytes };
  } finally {
    db.close();
  }
}

function getUniqueLocalImageIds(markdown) {
  const ids = new Set();
  let match = null;

  while ((match = LOCAL_IMAGE_TOKEN_PATTERN.exec(markdown)) !== null) {
    const imageId = match[1];
    if (imageId) {
      ids.add(imageId);
    }
  }

  LOCAL_IMAGE_TOKEN_PATTERN.lastIndex = 0;
  return Array.from(ids);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read image data"));
    reader.readAsDataURL(blob);
  });
}

async function resolveLocalImageTokens(markdown) {
  const ids = getUniqueLocalImageIds(markdown);
  if (ids.length === 0) {
    return { resolvedMarkdown: markdown, missingIds: [] };
  }

  let resolvedMarkdown = markdown;
  const missingIds = [];

  for (const imageId of ids) {
    const record = await getImageRecord(imageId);
    if (!record || !(record.blob instanceof Blob)) {
      missingIds.push(imageId);
      continue;
    }

    const dataUrl = await blobToDataUrl(record.blob);
    resolvedMarkdown = resolvedMarkdown
      .split(`${LOCAL_IMAGE_SCHEME}${imageId}`)
      .join(dataUrl);
  }

  return { resolvedMarkdown, missingIds };
}

async function getImageSnippetHistory() {
  const db = await openImageDb();

  try {
    const transaction = db.transaction(IMAGE_STORE_NAME, "readonly");
    const store = transaction.objectStore(IMAGE_STORE_NAME);
    const snippets = [];

    await new Promise((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }

        const value = cursor.value || {};
        const id = typeof value.id === "string" ? value.id : "";
        if (id) {
          snippets.push({
            createdAt: Number(value.createdAt) || 0,
            snippet: buildLocalImageSnippet(value.name, id),
          });
        }

        cursor.continue();
      };

      request.onerror = () =>
        reject(request.error || new Error("failed to read image snippet history"));
    });

    await transactionDone(transaction);
    snippets.sort((a, b) => b.createdAt - a.createdAt);
    return snippets.map((entry) => entry.snippet);
  } finally {
    db.close();
  }
}

function renderSnippetHistory(snippets, heading = "", message = "") {
  if (!(uploadResultContainer instanceof HTMLElement)) {
    return;
  }

  if (snippets.length === 0 && !heading && !message) {
    uploadResultContainer.innerHTML = "";
    return;
  }

  const headingHtml = heading ? `<h4>${escapeHtml(heading)}</h4>` : "";
  const messageHtml = message ? `<p>${escapeHtml(message)}</p>` : "";

  let detailsHtml = "";
  if (snippets.length > 0) {
    const openAttr = snippetDetailsIsOpen ? " open" : "";
    const snippetItems = snippets
      .map(
        (snippet) =>
          `<li style="all: revert;"><code style="all: revert;">${escapeHtml(snippet)}</code></li>`
      )
      .join("");
    detailsHtml = `
      <br>
      <details style="all: revert;" data-snippet-history="true"${openAttr}>
        <summary style="all: revert; cursor: pointer;">images (${snippets.length})</summary>
        <ol style="all: revert;">${snippetItems}</ol>
      </details><br>
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

async function refreshSnippetHistory(heading = "", message = "") {
  try {
    const snippets = await getImageSnippetHistory();
    renderSnippetHistory(snippets, heading, message);
  } catch {
    renderSnippetHistory([], "image upload failed", "unable to load image snippet history.");
  }
}

function showUploadError(message) {
  void refreshSnippetHistory("image upload failed", message);
}

async function showUploadResult(record) {
  const snippet = buildLocalImageSnippet(record.name, record.id);
  insertSnippetIntoMarkdown(snippet);
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
    const { totalBytes } = await getImageUsageStats();
    if (totalBytes + file.size > MAX_STORAGE_BYTES) {
      showUploadError("image upload limit reached. maximum total image capacity is 25GB.");
      return;
    }

    const record = {
      id: makeImageId(),
      name: file.name || "image",
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      createdAt: Date.now(),
      blob: file,
    };

    await saveImageRecord(record);
    await showUploadResult(record);
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

  setConvertLoadingState(true);

  try {
    const { resolvedMarkdown, missingIds } = await resolveLocalImageTokens(markdown);
    if (missingIds.length > 0) {
      showConvertError("one or more local images are missing from browser storage.");
      return;
    }

    const markdownBytes = new Blob([resolvedMarkdown]).size;
    if (markdownBytes > MAX_CONVERT_REQUEST_BYTES) {
      showConvertError(
        "resolved markdown is too large to send for conversion. reduce inserted images or set a higher MAX_CONTENT_LENGTH on the server."
      );
      return;
    }

    formData.set("markdown", resolvedMarkdown);

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
    if (resultContainer instanceof HTMLElement) {
      resultContainer.innerHTML = responseHtml;
      resultContainer.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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

restoreFormState();

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


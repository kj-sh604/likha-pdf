const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");
const imageInput = document.getElementById("image");
const convertForm = document.getElementById("convert-form");
const loadingIndicator = document.getElementById("loading");
const resultContainer = document.getElementById("result");
const uploadResultContainer = document.getElementById("upload-result");

const PERSISTENCE_KEY = "likha-pdf:form-state:v1";
const IMAGE_DB_NAME = "likha-pdf:image-db:v1";
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = "images";
const LOCAL_IMAGE_SCHEME = "local-image://";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_STORAGE_BYTES = 25 * 1024 * 1024 * 1024;
const MAX_CONVERT_REQUEST_BYTES = 512 * 1024 * 1024;
const LOCAL_IMAGE_TOKEN_PATTERN = /local-image:\/\/([a-zA-Z0-9-]+)/g;
const ALLOWED_IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|svg)$/i;

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

  if (loadingIndicator instanceof HTMLElement) {
    loadingIndicator.hidden = !isLoading;
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

let activePreviewUrl = "";

function showUploadError(message) {
  if (!(uploadResultContainer instanceof HTMLElement)) {
    return;
  }

  uploadResultContainer.innerHTML = `
    <article>
      <h4>image upload failed</h4>
      <pre>${escapeHtml(message)}</pre>
    </article>
  `;
}

function showUploadResult(record) {
  if (!(uploadResultContainer instanceof HTMLElement)) {
    return;
  }

  if (activePreviewUrl) {
    URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = "";
  }

  const snippet = buildLocalImageSnippet(record.name, record.id);
  activePreviewUrl = URL.createObjectURL(record.blob);

  uploadResultContainer.innerHTML = `
    <article>
      <h4>image ready for insert</h4>
      <p><a href="${escapeHtml(activePreviewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(record.name)}</a></p>
      <p><code id="uploaded-markdown">${escapeHtml(snippet)}</code></p>
      <button type="button" data-insert-markdown="${escapeHtml(snippet)}" class="insert-markdown">insert into markdown</button>
    </article>
  `;
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
    showUploadResult(record);
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

document.body.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest("[data-insert-markdown]");
  if (!(button instanceof HTMLElement) || !markdownInput) {
    return;
  }

  const snippet = button.dataset.insertMarkdown;
  if (!snippet) {
    return;
  }

  const needsLeadingNewline = markdownInput.value && !markdownInput.value.endsWith("\n");
  const prefix = needsLeadingNewline ? "\n" : "";
  markdownInput.value += `${prefix}${snippet}\n`;
  markdownInput.focus();
  collectFormState();
});


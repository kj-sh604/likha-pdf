const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");

function sourceForm(event) {
  const sourceElement = event.detail?.elt;
  if (!sourceElement) {
    return null;
  }
  return sourceElement.closest("form");
}

document.body.addEventListener("htmx:beforeRequest", (event) => {
  const form = sourceForm(event);
  if (form?.id === "convert-form" && convertButton) {
    convertButton.disabled = true;
    convertButton.textContent = "generating...";
  }

  if (form?.id === "upload-form" && uploadButton) {
    uploadButton.disabled = true;
    uploadButton.textContent = "uploading...";
  }
});

document.body.addEventListener("htmx:afterRequest", (event) => {
  const form = sourceForm(event);
  if (form?.id === "convert-form" && convertButton) {
    convertButton.disabled = false;
    convertButton.textContent = "generate pdf";
  }

  if (form?.id === "upload-form" && uploadButton) {
    uploadButton.disabled = false;
    uploadButton.textContent = "upload image";
  }
});

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
});

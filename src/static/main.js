const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");
const imageInput = document.getElementById("image");
const mdFileInput = document.getElementById("md-file");

document.body.addEventListener("htmx:beforeRequest", (event) => {
  const elt = event.detail?.elt;
  if (!elt) {
    return;
  }

  if (elt.id === "convert-form" && convertButton) {
    convertButton.disabled = true;
    convertButton.textContent = "generating...";
  }

  if (elt.id === "upload-button" && uploadButton) {
    uploadButton.disabled = true;
    uploadButton.textContent = "uploading...";
  }
});

document.body.addEventListener("htmx:afterRequest", (event) => {
  const elt = event.detail?.elt;
  if (!elt) {
    return;
  }

  if (elt.id === "convert-form" && convertButton) {
    convertButton.disabled = false;
    convertButton.textContent = "generate pdf";
  }

  if (elt.id === "upload-button" && uploadButton) {
    uploadButton.disabled = false;
    uploadButton.textContent = "upload image";
  }
});

if (mdFileInput) {
  mdFileInput.addEventListener("change", () => {
    const file = mdFileInput.files?.[0];

    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (markdownInput) {
          markdownInput.value = /** @type {string} */ (e.target.result);
          markdownInput.readOnly = true;
        }
        if (imageInput) {
          imageInput.disabled = true;
        }
        if (uploadButton) {
          uploadButton.disabled = true;
        }
      };
      reader.readAsText(file);
    } else {
      if (markdownInput) {
        markdownInput.value = "";
        markdownInput.readOnly = false;
      }
      if (imageInput) {
        imageInput.disabled = false;
      }
      if (uploadButton) {
        uploadButton.disabled = false;
      }
    }
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
});

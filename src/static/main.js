const convertButton = document.getElementById("convert-button");
const uploadButton = document.getElementById("upload-button");
const markdownInput = document.getElementById("markdown");
const imageInput = document.getElementById("image");
const mdFileInput = document.getElementById("md-file");


// stack overflow session state js
const convertForm=document.getElementById("convert-form"),PERSISTENCE_KEY="likha-pdf:form-state:v1";function readPersistedState(){try{const e=localStorage.getItem(PERSISTENCE_KEY);return e?JSON.parse(e):null}catch{return null}}function writePersistedState(e){try{localStorage.setItem(PERSISTENCE_KEY,JSON.stringify(e))}catch{}}function collectFormState(){if(!(convertForm instanceof HTMLFormElement))return;const e={},t=Array.from(convertForm.elements);for(const n of t){if(!(n instanceof HTMLElement))continue;const t=n.getAttribute("name");t&&"markdown"!==t&&(n instanceof HTMLInputElement?"radio"===n.type?n.checked&&(e[t]=n.value):"checkbox"===n.type&&(e[t]=n.checked):n instanceof HTMLSelectElement&&(e[t]=n.value))}writePersistedState({markdown:markdownInput?.value??"",fields:e})}function restoreFormState(){if(!(convertForm instanceof HTMLFormElement))return;const e=readPersistedState();if(!e||"object"!=typeof e)return;markdownInput&&"string"==typeof e.markdown&&(markdownInput.value=e.markdown,markdownInput.readOnly=!1),imageInput&&(imageInput.disabled=!1),uploadButton&&(uploadButton.disabled=!1);const t=e.fields;if(t&&"object"==typeof t)for(const[e,n]of Object.entries(t)){const t=convertForm.elements.namedItem(e);t&&(t instanceof RadioNodeList?t.value=String(n):t instanceof HTMLElement&&(t instanceof HTMLInputElement&&"checkbox"===t.type?t.checked=Boolean(n):(t instanceof HTMLInputElement||t instanceof HTMLSelectElement)&&(t.value=String(n))))}}restoreFormState();

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

if (convertForm instanceof HTMLFormElement) {
  convertForm.addEventListener("input", collectFormState);
  convertForm.addEventListener("change", collectFormState);
}

document.body.addEventListener("htmx:afterSwap", (event) => {
  const target = event.detail?.target;
  const requestElt = event.detail?.requestConfig?.elt;

  if (!(target instanceof HTMLElement) || target.id !== "result") {
    return;
  }

  if (!(requestElt instanceof HTMLElement) || requestElt.id !== "convert-form") {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "start" });
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
        collectFormState();
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
      collectFormState();
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
  collectFormState();
});

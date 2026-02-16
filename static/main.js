const convertButton = document.getElementById("convert-button");

document.body.addEventListener("htmx:beforeRequest", () => {
  if (convertButton) {
    convertButton.disabled = true;
    convertButton.textContent = "generating...";
  }
});

document.body.addEventListener("htmx:afterRequest", () => {
  if (convertButton) {
    convertButton.disabled = false;
    convertButton.textContent = "generate pdf";
  }
});

from __future__ import annotations

import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from flask import Flask, render_template, request, send_from_directory, url_for
from werkzeug.utils import secure_filename

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
GENERATED_DIR = BASE_DIR / "generated"
UPLOADS_DIR = BASE_DIR / "uploads"
LATEX_TEMPLATE = BASE_DIR / "latex" / "template.tex"

GENERATED_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg"}

PAPER_SIZES = {
    "a4paper": "A4",
    "letterpaper": "US Letter",
    "legalpaper": "US Legal",
}

MARGINS = {
    "0.75in": "Narrow (0.75in)",
    "1in": "Normal (1in)",
    "1.25in": "Comfort (1.25in)",
    "1.5in": "Wide (1.5in)",
}

MAIN_FONTS = {
    "serif": "TeX Gyre Pagella",
    "sans": "TeX Gyre Heros",
}


def _pick(options: dict[str, str], key: str, default_key: str) -> str:
    if key in options:
        return key
    return default_key


def _is_allowed_image(filename: str) -> bool:
    if "." not in filename:
        return False
    extension = filename.rsplit(".", 1)[1].lower()
    return extension in ALLOWED_IMAGE_EXTENSIONS


@app.get("/")
def index():
    return render_template(
        "index.html",
        paper_sizes=PAPER_SIZES,
        margins=MARGINS,
    )


@app.post("/convert")
def convert_markdown():
    markdown = request.form.get("markdown", "").strip()
    if not markdown:
        return render_template("partials/error.html", message="Markdown content is required."), 400

    paper_size_key = _pick(PAPER_SIZES, request.form.get("paper_size", ""), "a4paper")
    margin_key = _pick(MARGINS, request.form.get("margin", ""), "1in")
    main_family_key = request.form.get("main_font", "serif")

    if main_family_key not in MAIN_FONTS:
        main_family_key = "serif"

    epoch = int(time.time())
    unique_id = uuid.uuid4().hex
    output_name = f"likha-pdf_{epoch}_{unique_id}.pdf"
    output_path = GENERATED_DIR / output_name

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_markdown = Path(tmp_dir) / "source.md"
        temp_markdown.write_text(markdown, encoding="utf-8")

        command = [
            "pandoc",
            str(temp_markdown),
            "--from",
            "markdown+emoji",
            "--pdf-engine=lualatex",
            "--template",
            str(LATEX_TEMPLATE),
            "-V",
            f"papersize={paper_size_key}",
            "-V",
            f"margin={margin_key}",
            "-V",
            f"mainfont={MAIN_FONTS[main_family_key]}",
            "--resource-path",
            f"{BASE_DIR}:{UPLOADS_DIR}:{tmp_dir}",
            "-o",
            str(output_path),
        ]

        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except FileNotFoundError:
            return (
                render_template(
                    "partials/error.html",
                    message="Pandoc is not installed or not in PATH.",
                ),
                500,
            )
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            error_message = stderr[-1200:] if stderr else "PDF conversion failed."
            return render_template("partials/error.html", message=error_message), 400

    return render_template(
        "partials/result.html",
        download_url=url_for("download_pdf", filename=output_name),
        filename=output_name,
    )


@app.post("/upload-image")
def upload_image():
    image = request.files.get("image")
    if image is None or image.filename is None or not image.filename.strip():
        return render_template("partials/upload_error.html", message="image file is required."), 400

    original_name = secure_filename(image.filename)
    if not original_name or not _is_allowed_image(original_name):
        return render_template("partials/upload_error.html", message="unsupported image type."), 400

    extension = original_name.rsplit(".", 1)[1].lower()
    epoch = int(time.time())
    unique_id = uuid.uuid4().hex
    stored_name = f"img_{epoch}_{unique_id}.{extension}"
    image_path = UPLOADS_DIR / stored_name
    image.save(image_path)

    markdown_snippet = f"![]({(Path('uploads') / stored_name).as_posix()})"
    return render_template(
        "partials/upload_result.html",
        filename=stored_name,
        markdown_snippet=markdown_snippet,
        preview_url=url_for("uploaded_image", filename=stored_name),
    )


@app.get("/uploads/<path:filename>")
def uploaded_image(filename: str):
    return send_from_directory(UPLOADS_DIR, filename)


@app.get("/download/<path:filename>")
def download_pdf(filename: str):
    return send_from_directory(GENERATED_DIR, filename, as_attachment=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)

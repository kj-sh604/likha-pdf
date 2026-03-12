#!/usr/bin/env python3

# likha-pdf — markdown to pdf, no latex required
# converts markdown to html, then html to pdf via weasyprint
# falls back to reportlab if weasyprint chokes — a pdf is always produced

import os
import re
import secrets
import time

from flask import (
    Flask,
    request,
    send_from_directory,
    render_template_string,
    abort,
)
from markupsafe import escape
from markdown import markdown
from pygments.formatters import HtmlFormatter
from weasyprint import HTML

APP_NAME = "likha-pdf"
PORT = 5001

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GENERATED_DIR = os.path.join(BASE_DIR, "generated")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
PARTIALS_DIR = os.path.join(TEMPLATES_DIR, "partials")
STATIC_DIR = os.path.join(BASE_DIR, "static")

ALLOWED_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "svg"}

VALID_PAPER_SIZES = {
    "a0paper", "a1paper", "a2paper", "a3paper", "a4paper", "a5paper", "a6paper",
    "b0paper", "b1paper", "b2paper", "b3paper", "b4paper", "b5paper", "b6paper",
    "c4paper", "c5paper", "c6paper",
    "letterpaper", "legalpaper", "executivepaper",
    "ledgerpaper", "tabloid", "statement", "flsa",
}

VALID_MARGINS = {"0.25in", "0.5in", "0.75in", "1in", "1.25in", "1.5in", "1.75in"}

VALID_LINE_SPACINGS = {"1", "1.5", "2"}

# css page dimensions for each paper size
PAPER_CSS = {
    "a0paper":          "841mm 1189mm",
    "a1paper":          "594mm 841mm",
    "a2paper":          "420mm 594mm",
    "a3paper":          "297mm 420mm",
    "a4paper":          "210mm 297mm",
    "a5paper":          "148mm 210mm",
    "a6paper":          "105mm 148mm",
    "b0paper":          "1000mm 1414mm",
    "b1paper":          "707mm 1000mm",
    "b2paper":          "500mm 707mm",
    "b3paper":          "353mm 500mm",
    "b4paper":          "250mm 353mm",
    "b5paper":          "176mm 250mm",
    "b6paper":          "125mm 176mm",
    "c4paper":          "229mm 324mm",
    "c5paper":          "162mm 229mm",
    "c6paper":          "114mm 162mm",
    "letterpaper":      "8.5in 11in",
    "legalpaper":       "8.5in 14in",
    "executivepaper":   "7in 10in",
    "ledgerpaper":      "17in 11in",
    "tabloid":          "11in 17in",
    "statement":        "5.5in 8.5in",
    "flsa":             "8.5in 13in",
}

MARKDOWN_EXTENSIONS = [
    "tables",
    "fenced_code",
    "codehilite",
    "nl2br",
    "sane_lists",
    "smarty",
    "toc",
    "attr_list",
    "md_in_html",
]

MARKDOWN_EXT_CONFIG = {
    "codehilite": {
        "css_class": "highlight",
        "guess_lang": True,
        "noclasses": True,
    },
}

app = Flask(
    __name__,
    template_folder=TEMPLATES_DIR,
    static_folder=STATIC_DIR,
    static_url_path="/static",
)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64 MB


# helpers
def random_hex(length=32):
    return secrets.token_hex(length // 2)


def pick_option(value, fallback, valid):
    return value if value in valid else fallback


def sanitize_filename(name):
    """keep only safe characters in a filename"""
    name = os.path.basename(name.replace("\\", "/"))
    out = []
    for ch in name:
        if ch.isalnum() or ch in "-_.":
            out.append(ch)
        elif ch == " ":
            out.append("_")
    return "".join(out)


def is_allowed_image(filename):
    dot = filename.rfind(".")
    if dot < 1 or dot == len(filename) - 1:
        return False
    ext = filename[dot + 1:].lower()
    return ext in ALLOWED_IMAGE_EXTS


def is_safe_relative_path(path_part):
    return (
        bool(path_part)
        and ".." not in path_part
        and "\\" not in path_part
        and not path_part.startswith("/")
    )


def read_partial(name, replacements=None):
    """read a partial html template and apply replacements"""
    path = os.path.join(PARTIALS_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if replacements:
        for token, value in replacements.items():
            content = content.replace(token, value)
    return content


def tail_text(value, max_len=1200):
    if len(value) <= max_len:
        return value
    return value[-max_len:]


# pdf stylesheet generator
def build_pdf_css(paper_size, margin, font_family, line_spacing, show_page_numbers):
    """build the css for weasyprint pdf rendering"""
    page_dims = PAPER_CSS.get(paper_size, "8.5in 11in")

    if font_family == "sans":
        font_stack = '"Helvetica Neue", Helvetica, Arial, "Noto Sans", sans-serif'
    else:
        font_stack = '"Georgia", "Noto Serif", "Times New Roman", serif'

    page_number_css = ""
    if show_page_numbers:
        page_number_css = """
        @bottom-center {
            content: counter(page);
            font-size: 9pt;
            color: #666;
        }"""

    return f"""
@page {{
    size: {page_dims};
    margin: {margin};{page_number_css}
}}

body {{
    font-family: {font_stack};
    font-size: 11pt;
    line-height: {line_spacing};
    color: #000;
    word-wrap: break-word;
    overflow-wrap: break-word;
}}

h1, h2, h3, h4, h5, h6 {{
    margin-top: 1em;
    margin-bottom: 0.4em;
    page-break-after: avoid;
}}

h1 {{ font-size: 20pt; }}
h2 {{ font-size: 16pt; }}
h3 {{ font-size: 13pt; }}
h4 {{ font-size: 11pt; }}

p {{
    margin: 0 0 0.6em 0;
}}

pre {{
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 3px;
    padding: 0.6em;
    font-size: 9pt;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    page-break-inside: avoid;
}}

code {{
    font-family: "Courier New", Courier, "Liberation Mono", monospace;
    font-size: 9pt;
}}

p > code, li > code {{
    background: #f0f0f0;
    padding: 0.1em 0.3em;
    border-radius: 2px;
}}

blockquote {{
    border-left: 3px solid #ccc;
    margin: 0.6em 0;
    padding: 0.3em 0.8em;
    color: #555;
}}

table {{
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    page-break-inside: avoid;
}}

th, td {{
    border: 1px solid #ccc;
    padding: 0.4em 0.6em;
    text-align: left;
}}

th {{
    background: #f5f5f5;
    font-weight: bold;
}}

img {{
    max-width: 100%;
    height: auto;
}}

a {{
    color: #0066cc;
    text-decoration: underline;
}}

hr {{
    border: none;
    border-top: 1px solid #ccc;
    margin: 1em 0;
}}

ul, ol {{
    margin: 0.4em 0;
    padding-left: 1.5em;
}}

li {{
    margin-bottom: 0.2em;
}}
"""


# pdf conversion
def markdown_to_html(source):
    """convert markdown text to an html fragment"""
    return markdown(
        source,
        extensions=MARKDOWN_EXTENSIONS,
        extension_configs=MARKDOWN_EXT_CONFIG,
    )


def build_full_html(body_html, css):
    """wrap the converted html body in a full document with styles"""
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
{css}
</style>
</head>
<body>
{body_html}
</body>
</html>"""


def convert_with_weasyprint(full_html, output_path):
    """render html to pdf via weasyprint. returns (ok, error_msg)."""
    try:
        doc = HTML(
            string=full_html,
            base_url=BASE_DIR,
        )
        doc.write_pdf(output_path)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def convert_with_reportlab(source_markdown, output_path, paper_size, margin,
                           font_family, line_spacing):
    """fallback: produce a basic text pdf with reportlab.
    not pretty, but guarantees a file is always created."""
    from reportlab.lib.pagesizes import (
        A0, A1, A2, A3, A4, A5, A6,
        B0, B1, B2, B3, B4, B5, B6,
        LETTER, LEGAL, LEDGER, TABLOID,
    )
    from reportlab.lib.units import inch, mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_LEFT

    size_map = {
        "a0paper": A0, "a1paper": A1, "a2paper": A2, "a3paper": A3,
        "a4paper": A4, "a5paper": A5, "a6paper": A6,
        "b0paper": B0, "b1paper": B1, "b2paper": B2, "b3paper": B3,
        "b4paper": B4, "b5paper": B5, "b6paper": B6,
        "letterpaper": LETTER, "legalpaper": LEGAL,
        "executivepaper": (7 * inch, 10 * inch),
        "ledgerpaper": LEDGER, "tabloid": TABLOID,
        "statement": (5.5 * inch, 8.5 * inch),
        "flsa": (8.5 * inch, 13 * inch),
        "c4paper": (229 * mm, 324 * mm),
        "c5paper": (162 * mm, 229 * mm),
        "c6paper": (114 * mm, 162 * mm),
    }

    margin_map = {
        "0.25in": 0.25 * inch, "0.5in": 0.5 * inch, "0.75in": 0.75 * inch,
        "1in": 1.0 * inch, "1.25in": 1.25 * inch, "1.5in": 1.5 * inch,
        "1.75in": 1.75 * inch,
    }

    pagesize = size_map.get(paper_size, LETTER)
    m = margin_map.get(margin, 1.0 * inch)

    doc = SimpleDocTemplate(
        output_path,
        pagesize=pagesize,
        leftMargin=m, rightMargin=m,
        topMargin=m, bottomMargin=m,
    )

    styles = getSampleStyleSheet()
    font_name = "Helvetica" if font_family == "sans" else "Times-Roman"
    spacing_val = float(line_spacing) if line_spacing else 1.0

    body_style = ParagraphStyle(
        "BodyCustom",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=11,
        leading=11 * spacing_val * 1.2,
        alignment=TA_LEFT,
    )

    code_style = ParagraphStyle(
        "CodeCustom",
        parent=styles["Code"],
        fontName="Courier",
        fontSize=9,
        leading=11,
        leftIndent=12,
    )

    story = []
    in_code_block = False
    code_lines = []

    for line in source_markdown.splitlines():
        if line.startswith("```"):
            if in_code_block:
                # close code block
                code_text = "\n".join(code_lines)
                story.append(Preformatted(code_text, code_style))
                story.append(Spacer(1, 6))
                code_lines = []
                in_code_block = False
            else:
                in_code_block = True
            continue

        if in_code_block:
            code_lines.append(line)
            continue

        stripped = line.strip()

        if not stripped:
            story.append(Spacer(1, 6))
            continue

        # heading detection
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            level = min(level, 6)
            text = stripped.lstrip("#").strip()
            heading_style = ParagraphStyle(
                f"H{level}",
                parent=styles["Heading1"],
                fontName=font_name,
                fontSize=max(20 - (level * 2), 11),
            )
            story.append(Paragraph(text, heading_style))
            story.append(Spacer(1, 4))
            continue

        story.append(Paragraph(line, body_style))

    # flush any unclosed code block
    if code_lines:
        code_text = "\n".join(code_lines)
        story.append(Preformatted(code_text, code_style))

    doc.build(story)


def generate_pdf(source_markdown, output_path, paper_size, margin,
                 font_family, line_spacing, show_page_numbers):
    """convert markdown to pdf. always produces a file."""
    body_html = markdown_to_html(source_markdown)
    css = build_pdf_css(paper_size, margin, font_family, line_spacing, show_page_numbers)
    full_html = build_full_html(body_html, css)

    ok, err = convert_with_weasyprint(full_html, output_path)
    if ok:
        return True, ""

    # weasyprint failed — fall back to reportlab
    try:
        convert_with_reportlab(
            source_markdown, output_path,
            paper_size, margin, font_family, line_spacing,
        )
        return True, f"(used fallback renderer) {err}"
    except Exception as fallback_err:
        return False, f"weasyprint: {err} | reportlab: {fallback_err}"


# routes
@app.route("/")
def index():
    index_path = os.path.join(TEMPLATES_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        return f.read()


@app.route("/convert", methods=["POST"])
def convert():
    md = request.form.get("markdown", "").strip()
    if not md:
        return read_partial("error.html", {
            "{{ message }}": "Markdown content is required.",
        }), 400

    paper_size = pick_option(
        request.form.get("paper_size", ""), "letterpaper", VALID_PAPER_SIZES,
    )
    margin = pick_option(
        request.form.get("margin", ""), "1in", VALID_MARGINS,
    )

    font_family = request.form.get("main_font", "serif")
    if font_family not in ("serif", "sans"):
        font_family = "serif"

    line_spacing = pick_option(
        request.form.get("line_spacing", ""), "1", VALID_LINE_SPACINGS,
    )
    show_page_numbers = request.form.get("page_numbers") == "on"

    epoch = int(time.time())
    output_name = f"{APP_NAME}_{epoch}_{random_hex()}.pdf"
    output_path = os.path.join(GENERATED_DIR, output_name)

    ok, err = generate_pdf(
        md, output_path,
        paper_size, margin, font_family, line_spacing, show_page_numbers,
    )

    if not ok:
        return read_partial("error.html", {
            "{{ message }}": str(escape(tail_text(err))),
        }), 500

    return read_partial("result.html", {
        "{{ filename }}": str(escape(output_name)),
        "{{ download_url }}": f"/download/{output_name}",
    })


@app.route("/upload-image", methods=["POST"])
def upload_image():
    uploaded = request.files.get("image")
    if not uploaded or not uploaded.filename or not uploaded.filename.strip():
        return read_partial("upload_error.html", {
            "{{ message }}": "image file is required.",
        }), 400

    original = sanitize_filename(uploaded.filename)
    if not original or not is_allowed_image(original):
        return read_partial("upload_error.html", {
            "{{ message }}": "unsupported image type.",
        }), 400

    ext = original.rsplit(".", 1)[-1].lower()
    epoch = int(time.time())
    stored_name = f"img_{epoch}_{random_hex()}.{ext}"
    image_path = os.path.join(UPLOADS_DIR, stored_name)
    uploaded.save(image_path)

    snippet = f"![](uploads/{stored_name})"
    return read_partial("upload_result.html", {
        "{{ filename }}": str(escape(stored_name)),
        "{{ markdown_snippet }}": str(escape(snippet)),
        "{{ preview_url }}": f"/uploads/{stored_name}",
    })


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    if not is_safe_relative_path(filename):
        abort(400)
    return send_from_directory(UPLOADS_DIR, filename)


@app.route("/download/<path:filename>")
def download(filename):
    if not is_safe_relative_path(filename):
        abort(400)
    return send_from_directory(
        GENERATED_DIR, filename,
        as_attachment=True,
        download_name=filename,
    )


# main
if __name__ == "__main__":
    os.makedirs(GENERATED_DIR, exist_ok=True)
    os.makedirs(UPLOADS_DIR, exist_ok=True)

    print(f"  {APP_NAME} listening on http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)

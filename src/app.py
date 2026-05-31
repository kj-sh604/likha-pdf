#!/usr/bin/env python3

# likha-pdf — markdown to pdf, no latex required
# production-friendly flask app with weasyprint + reportlab fallback

import logging
import io
import os
import secrets
import sqlite3
import time
from collections import deque
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from flask import (
    Flask,
    Response,
    current_app,
    request,
    send_from_directory,
)
from markupsafe import escape
from markdown import markdown
from weasyprint import HTML, default_url_fetcher
from werkzeug.middleware.proxy_fix import ProxyFix

APP_NAME = "likha-pdf"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5001
DEFAULT_MAX_CONTENT_LENGTH = 2048 * 1024 * 1024
DEFAULT_MAX_FORM_MEMORY_SIZE = DEFAULT_MAX_CONTENT_LENGTH
DEFAULT_CONVERT_RATE_LIMIT_REQUESTS = 5
DEFAULT_CONVERT_RATE_LIMIT_WINDOW_SECONDS = 60
DEFAULT_CONVERT_RATE_LIMIT_DB_PATH = "/tmp/likha-pdf-rate-limit.sqlite3"
DEFAULT_CONVERT_RATE_LIMIT_DB_WAL_AUTOCHECKPOINT_PAGES = 256
DEFAULT_CONVERT_RATE_LIMIT_DB_JOURNAL_SIZE_LIMIT_BYTES = 2 * 1024 * 1024
DEFAULT_CONVERT_RATE_LIMIT_DB_CACHE_SIZE_KIB = 2048

DEFAULT_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "object-src 'none'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "img-src 'self' data: blob: https:; "
    "font-src 'self' data: https://cdn.jsdelivr.net; "
    "connect-src 'self'"
)

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
PARTIALS_DIR = TEMPLATES_DIR / "partials"
STATIC_DIR = BASE_DIR / "static"

VALID_PAPER_SIZES = {
    "a0paper",
    "a1paper",
    "a2paper",
    "a3paper",
    "a4paper",
    "a5paper",
    "a6paper",
    "b0paper",
    "b1paper",
    "b2paper",
    "b3paper",
    "b4paper",
    "b5paper",
    "b6paper",
    "c4paper",
    "c5paper",
    "c6paper",
    "letterpaper",
    "legalpaper",
    "executivepaper",
    "ledgerpaper",
    "tabloid",
    "statement",
    "flsa",
}

VALID_MARGINS = {
    "0.25in",
    "0.35in",
    "0.5in",
    "0.75in",
    "1in",
    "1.25in",
    "1.5in",
    "1.75in",
}

VALID_LINE_SPACINGS = {"1", "1.15", "1.5", "2"}

# css page dimensions for each paper size
PAPER_CSS = {
    "a0paper": "841mm 1189mm",
    "a1paper": "594mm 841mm",
    "a2paper": "420mm 594mm",
    "a3paper": "297mm 420mm",
    "a4paper": "210mm 297mm",
    "a5paper": "148mm 210mm",
    "a6paper": "105mm 148mm",
    "b0paper": "1000mm 1414mm",
    "b1paper": "707mm 1000mm",
    "b2paper": "500mm 707mm",
    "b3paper": "353mm 500mm",
    "b4paper": "250mm 353mm",
    "b5paper": "176mm 250mm",
    "b6paper": "125mm 176mm",
    "c4paper": "229mm 324mm",
    "c5paper": "162mm 229mm",
    "c6paper": "114mm 162mm",
    "letterpaper": "8.5in 11in",
    "legalpaper": "8.5in 14in",
    "executivepaper": "7in 10in",
    "ledgerpaper": "17in 11in",
    "tabloid": "11in 17in",
    "statement": "5.5in 8.5in",
    "flsa": "8.5in 13in",
}

MARKDOWN_BASE_EXTENSIONS = [
    "tables",
    "fenced_code",
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


# helpers
def env_bool(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name, default, minimum=1):
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        parsed = int(raw.strip())
    except ValueError:
        return default
    if parsed < minimum:
        return minimum
    return parsed


def pick_option(value, fallback, valid):
    return value if value in valid else fallback


def read_partial(name, replacements=None):
    """read a partial html template and apply replacements"""
    content = (PARTIALS_DIR / name).read_text(encoding="utf-8")
    if replacements:
        for token, value in replacements.items():
            content = content.replace(token, value)
    return content


def tail_text(value, max_len=1200):
    if len(value) <= max_len:
        return value
    return value[-max_len:]


def format_bytes(num_bytes):
    if num_bytes < 1024:
        return f"{num_bytes} B"

    units = ["KB", "MB", "GB", "TB"]
    value = float(num_bytes)
    for unit in units:
        value /= 1024.0
        if value < 1024.0:
            return f"{value:.2f} {unit}"

    return f"{value:.2f} PB"


def safe_weasy_url_fetcher(url, *args, **kwargs):
    """allow only data urls, block file/network/relative resources"""
    scheme = (urlsplit(url).scheme or "").lower()
    if scheme == "data":
        return default_url_fetcher(url, *args, **kwargs)
    raise ValueError("blocked non-data resource url")


class SlidingWindowRateLimiter:
    def __init__(
        self,
        max_requests,
        window_seconds,
        db_path=None,
        wal_autocheckpoint_pages=DEFAULT_CONVERT_RATE_LIMIT_DB_WAL_AUTOCHECKPOINT_PAGES,
        journal_size_limit_bytes=DEFAULT_CONVERT_RATE_LIMIT_DB_JOURNAL_SIZE_LIMIT_BYTES,
        cache_size_kib=DEFAULT_CONVERT_RATE_LIMIT_DB_CACHE_SIZE_KIB,
    ):
        self.max_requests = max_requests
        self.window_seconds = float(window_seconds)
        self.db_path = Path(db_path).expanduser() if db_path else None
        self.wal_autocheckpoint_pages = int(wal_autocheckpoint_pages)
        self.journal_size_limit_bytes = int(journal_size_limit_bytes)
        self.cache_size_kib = int(cache_size_kib)

        self._events = {}
        self._memory_lock = Lock()
        self._memory_next_cleanup_at = 0.0
        self._schema_lock = Lock()
        self._schema_ready = False

        if self.db_path is not None:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _allow_memory(self, key):
        now = time.monotonic()
        window_start = now - self.window_seconds

        with self._memory_lock:
            if now >= self._memory_next_cleanup_at:
                stale_keys = []
                for event_key, entries in self._events.items():
                    while entries and entries[0] <= window_start:
                        entries.popleft()
                    if not entries:
                        stale_keys.append(event_key)

                for stale_key in stale_keys:
                    self._events.pop(stale_key, None)

                self._memory_next_cleanup_at = now + min(self.window_seconds, 30.0)

            entries = self._events.get(key)
            if entries is None:
                entries = deque()
                self._events[key] = entries

            while entries and entries[0] <= window_start:
                entries.popleft()

            if len(entries) >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - entries[0])))
                return False, retry_after

            entries.append(now)

        return True, 0

    def _connect_db(self):
        conn = sqlite3.connect(str(self.db_path), timeout=5.0, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute(f"PRAGMA wal_autocheckpoint={self.wal_autocheckpoint_pages}")
        conn.execute(f"PRAGMA journal_size_limit={self.journal_size_limit_bytes}")
        conn.execute(f"PRAGMA cache_size={-self.cache_size_kib}")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _ensure_schema(self):
        if self._schema_ready:
            return

        with self._schema_lock:
            if self._schema_ready:
                return

            conn = self._connect_db()
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS rate_limit_events (
                        bucket_key TEXT NOT NULL,
                        event_ts REAL NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_ts
                    ON rate_limit_events (bucket_key, event_ts)
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_rate_limit_events_ts
                    ON rate_limit_events (event_ts)
                    """
                )
            finally:
                conn.close()

            self._schema_ready = True

    def _allow_sqlite(self, key):
        now = time.time()
        window_start = now - self.window_seconds
        try:
            self._ensure_schema()
            conn = self._connect_db()
        except sqlite3.Error as exc:
            logging.getLogger(APP_NAME).warning(
                "rate limiter sqlite init error, using memory fallback: %s", exc
            )
            return self._allow_memory(key)

        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "DELETE FROM rate_limit_events WHERE event_ts <= ?",
                (window_start,),
            )

            row = conn.execute(
                """
                SELECT COUNT(*), MIN(event_ts)
                FROM rate_limit_events
                WHERE bucket_key = ? AND event_ts > ?
                """,
                (key, window_start),
            ).fetchone()
            count = int(row[0] or 0)
            oldest = float(row[1]) if row and row[1] is not None else now

            if count >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - oldest)))
                conn.execute("COMMIT")
                return False, retry_after

            conn.execute(
                "INSERT INTO rate_limit_events (bucket_key, event_ts) VALUES (?, ?)",
                (key, now),
            )
            conn.execute("COMMIT")
            return True, 0
        except sqlite3.Error as exc:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass

            logging.getLogger(APP_NAME).warning(
                "rate limiter sqlite error, using memory fallback: %s", exc
            )
            return self._allow_memory(key)
        finally:
            conn.close()

    def allow(self, key):
        if self.db_path is None:
            return self._allow_memory(key)
        return self._allow_sqlite(key)


# pdf stylesheet generator
def build_pdf_css(
    paper_size,
    margin,
    font_family,
    line_spacing,
    show_page_numbers,
    disable_backgrounds,
):
    """build the css for weasyprint pdf rendering"""
    page_dims = PAPER_CSS.get(paper_size, "8.5in 11in")

    if font_family == "sans":
        font_stack = (
            '"Liberation Sans", "TeX Gyre Heros", "CMU Sans Serif", FreeSans, "Droid Sans", '
            '"Segoe UI Variable", "Segoe UI", Tahoma, "SF Pro Text", '
            '"SF Pro Display", "Helvetica Neue", Helvetica, Arial, '
            '"Lucida Grande", sans-serif'
        )
    elif font_family == "system-ui":
        font_stack = (
            '"Adwaita Sans", "Cantarell", "Ubuntu", "Liberation Sans", '
            'FreeSans, "Droid Sans", "Segoe UI Variable", "Segoe UI", '
            'Tahoma, "SF Pro Text", "SF Pro Display", "Helvetica Neue", '
            'Helvetica, Arial, "Lucida Grande", system-ui, '
            '-apple-system, BlinkMacSystemFont, sans-serif'
        )
    else:
        font_stack = (
            '"CMU Serif", "Liberation Serif", "TeX Gyre Termes", FreeSerif, '
            '"Nimbus Roman", "Droid Serif", "Times New Roman", Cambria, '
            'Constantia, Georgia, "New York", Garamond, "Times", '
            'Palatino, "Book Antiqua", serif'
        )

    page_number_css = ""
    if show_page_numbers:
        page_number_css = """
        @bottom-center {
            content: counter(page);
            font-size: 9pt;
            color: #666;
        }"""

    code_block_background = "transparent" if disable_backgrounds else "#f5f5f5"
    code_block_border = "none" if disable_backgrounds else "1px solid #ddd"
    inline_code_background = "transparent" if disable_backgrounds else "#f0f0f0"
    table_header_background = "transparent" if disable_backgrounds else "#f5f5f5"
    codehilite_span_background = "transparent" if disable_backgrounds else "inherit"
    code_background_reset_css = ""
    if disable_backgrounds:
        code_background_reset_css = """
.highlight,
.codehilite,
.highlight pre,
.codehilite pre,
pre code {
    background: transparent !important;
}
"""

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
    background: {code_block_background};
    border: {code_block_border};
    border-radius: 3px;
    padding: 0.6em;
    font-size: 9pt;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    page-break-inside: avoid;
}}

code {{
    font-family: "Roboto Mono", "JetBrains Mono", "Ubuntu Mono", "Liberation Mono", "Nimbus Mono PS", "Droid Sans Mono", "Source Code Pro", "Fira Code", Hack, Consolas, "Cascadia Mono", "Courier New", "SF Mono", Menlo, Monaco, ui-monospace, monospace;
    font-size: 9pt;
}}

p > code, li > code {{
    background: {inline_code_background};
    padding: 0.1em 0.3em;
    border-radius: 2px;
}}

.highlight span {{
    background: {codehilite_span_background} !important;
}}

{code_background_reset_css}

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
    background: {table_header_background};
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
def markdown_to_html(source, enable_syntax_highlighting=True):
    """convert markdown text to an html fragment"""
    extensions = list(MARKDOWN_BASE_EXTENSIONS)
    extension_configs = {}
    if enable_syntax_highlighting:
        extensions.append("codehilite")
        extension_configs = MARKDOWN_EXT_CONFIG

    return markdown(
        source,
        extensions=extensions,
        extension_configs=extension_configs,
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


def convert_with_weasyprint(full_html):
    """render html to pdf via weasyprint. returns (ok, pdf_bytes, error_msg)."""
    try:
        doc = HTML(
            string=full_html,
            url_fetcher=safe_weasy_url_fetcher,
        )
        return True, doc.write_pdf(), ""
    except Exception as exc:
        return False, b"", str(exc)


def convert_with_reportlab(
    source_markdown, paper_size, margin, font_family, line_spacing
):
    """fallback: produce a basic text pdf with reportlab.
    not pretty, but guarantees a file is always created."""
    from reportlab.lib.pagesizes import (
        A0,
        A1,
        A2,
        A3,
        A4,
        A5,
        A6,
        B0,
        B1,
        B2,
        B3,
        B4,
        B5,
        B6,
        LETTER,
        LEGAL,
        LEDGER,
        TABLOID,
    )
    from reportlab.lib.units import inch, mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_LEFT

    size_map = {
        "a0paper": A0,
        "a1paper": A1,
        "a2paper": A2,
        "a3paper": A3,
        "a4paper": A4,
        "a5paper": A5,
        "a6paper": A6,
        "b0paper": B0,
        "b1paper": B1,
        "b2paper": B2,
        "b3paper": B3,
        "b4paper": B4,
        "b5paper": B5,
        "b6paper": B6,
        "letterpaper": LETTER,
        "legalpaper": LEGAL,
        "executivepaper": (7 * inch, 10 * inch),
        "ledgerpaper": LEDGER,
        "tabloid": TABLOID,
        "statement": (5.5 * inch, 8.5 * inch),
        "flsa": (8.5 * inch, 13 * inch),
        "c4paper": (229 * mm, 324 * mm),
        "c5paper": (162 * mm, 229 * mm),
        "c6paper": (114 * mm, 162 * mm),
    }

    margin_map = {
        "0.25in": 0.25 * inch,
        "0.35in": 0.35 * inch,
        "0.5in": 0.5 * inch,
        "0.75in": 0.75 * inch,
        "1in": 1.0 * inch,
        "1.25in": 1.25 * inch,
        "1.5in": 1.5 * inch,
        "1.75in": 1.75 * inch,
    }

    pagesize = size_map.get(paper_size, LETTER)
    m = margin_map.get(margin, 1.0 * inch)

    buffer = io.BytesIO()

    doc = SimpleDocTemplate(
        buffer,
        pagesize=pagesize,
        leftMargin=m,
        rightMargin=m,
        topMargin=m,
        bottomMargin=m,
    )

    styles = getSampleStyleSheet()
    font_name = "Helvetica" if font_family in ("sans", "system-ui") else "Times-Roman"
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
    return buffer.getvalue()


def generate_pdf(
    source_markdown,
    paper_size,
    margin,
    font_family,
    line_spacing,
    show_page_numbers,
    enable_syntax_highlighting,
    disable_backgrounds,
):
    """convert markdown to pdf. always produces a file."""
    body_html = markdown_to_html(source_markdown, enable_syntax_highlighting)
    css = build_pdf_css(
        paper_size,
        margin,
        font_family,
        line_spacing,
        show_page_numbers,
        disable_backgrounds,
    )
    full_html = build_full_html(body_html, css)

    ok, pdf_bytes, err = convert_with_weasyprint(full_html)
    if ok:
        return True, pdf_bytes, ""

    # weasyprint failed — fall back to reportlab
    try:
        current_app.logger.warning(
            "weasyprint failed, using reportlab fallback: %s", err
        )
        pdf_bytes = convert_with_reportlab(
            source_markdown,
            paper_size,
            margin,
            font_family,
            line_spacing,
        )
        return True, pdf_bytes, f"(used fallback renderer) {err}"
    except Exception as fallback_err:
        return False, b"", f"weasyprint: {err} | reportlab: {fallback_err}"


def create_app():
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
        static_url_path="/static",
    )

    max_content_length = int(
        os.getenv("MAX_CONTENT_LENGTH", str(DEFAULT_MAX_CONTENT_LENGTH))
    )
    max_form_memory_size = int(
        os.getenv("MAX_FORM_MEMORY_SIZE", str(DEFAULT_MAX_FORM_MEMORY_SIZE))
    )

    app.config["MAX_CONTENT_LENGTH"] = max_content_length
    app.config["MAX_FORM_MEMORY_SIZE"] = max_form_memory_size

    convert_rate_limit_requests = env_int(
        "CONVERT_RATE_LIMIT_REQUESTS",
        DEFAULT_CONVERT_RATE_LIMIT_REQUESTS,
        minimum=1,
    )
    convert_rate_limit_window_seconds = env_int(
        "CONVERT_RATE_LIMIT_WINDOW_SECONDS",
        DEFAULT_CONVERT_RATE_LIMIT_WINDOW_SECONDS,
        minimum=1,
    )
    convert_rate_limit_db_path = os.getenv(
        "CONVERT_RATE_LIMIT_DB_PATH",
        DEFAULT_CONVERT_RATE_LIMIT_DB_PATH,
    ).strip()
    if convert_rate_limit_db_path.lower() in {"", "memory", "in-memory", "none"}:
        convert_rate_limit_db_path = ""

    convert_rate_limit_db_wal_autocheckpoint_pages = env_int(
        "CONVERT_RATE_LIMIT_DB_WAL_AUTOCHECKPOINT_PAGES",
        DEFAULT_CONVERT_RATE_LIMIT_DB_WAL_AUTOCHECKPOINT_PAGES,
        minimum=1,
    )
    convert_rate_limit_db_journal_size_limit_bytes = env_int(
        "CONVERT_RATE_LIMIT_DB_JOURNAL_SIZE_LIMIT_BYTES",
        DEFAULT_CONVERT_RATE_LIMIT_DB_JOURNAL_SIZE_LIMIT_BYTES,
        minimum=64 * 1024,
    )
    convert_rate_limit_db_cache_size_kib = env_int(
        "CONVERT_RATE_LIMIT_DB_CACHE_SIZE_KIB",
        DEFAULT_CONVERT_RATE_LIMIT_DB_CACHE_SIZE_KIB,
        minimum=256,
    )

    convert_rate_limiter = SlidingWindowRateLimiter(
        max_requests=convert_rate_limit_requests,
        window_seconds=convert_rate_limit_window_seconds,
        db_path=convert_rate_limit_db_path or None,
        wal_autocheckpoint_pages=convert_rate_limit_db_wal_autocheckpoint_pages,
        journal_size_limit_bytes=convert_rate_limit_db_journal_size_limit_bytes,
        cache_size_kib=convert_rate_limit_db_cache_size_kib,
    )

    app.config["CONVERT_RATE_LIMIT_REQUESTS"] = convert_rate_limit_requests
    app.config["CONVERT_RATE_LIMIT_WINDOW_SECONDS"] = (
        convert_rate_limit_window_seconds
    )
    app.config["CONVERT_RATE_LIMIT_DB_PATH"] = convert_rate_limit_db_path or "memory"
    app.config["CONVERT_RATE_LIMIT_DB_WAL_AUTOCHECKPOINT_PAGES"] = (
        convert_rate_limit_db_wal_autocheckpoint_pages
    )
    app.config["CONVERT_RATE_LIMIT_DB_JOURNAL_SIZE_LIMIT_BYTES"] = (
        convert_rate_limit_db_journal_size_limit_bytes
    )
    app.config["CONVERT_RATE_LIMIT_DB_CACHE_SIZE_KIB"] = (
        convert_rate_limit_db_cache_size_kib
    )

    trust_proxy = env_bool("TRUST_PROXY", default=False)
    app.config["TRUST_PROXY"] = trust_proxy
    if trust_proxy:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    app.logger.setLevel(log_level)

    @app.after_request
    def add_security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Content-Security-Policy", DEFAULT_CONTENT_SECURITY_POLICY)
        return resp

    @app.errorhandler(413)
    def payload_too_large(_err):
        content_limit = int(app.config.get("MAX_CONTENT_LENGTH") or 0)
        form_limit = int(app.config.get("MAX_FORM_MEMORY_SIZE") or 0)
        content_limit_text = (
            format_bytes(content_limit) if content_limit else "configured limit"
        )
        form_limit_text = format_bytes(form_limit) if form_limit else "unlimited"
        return (
            read_partial(
                "error.html",
                {
                    "{{ message }}": (
                        "request body too large. "
                        f"max request size is {content_limit_text}; "
                        f"max form field memory is {form_limit_text}."
                    ),
                },
            ),
            413,
        )

    @app.route("/healthz")
    def healthz():
        return Response("ok\n", mimetype="text/plain")

    @app.route("/")
    def index():
        return send_from_directory(str(TEMPLATES_DIR), "index.html")

    @app.route("/favicon.svg")
    def favicon():
        return send_from_directory(str(BASE_DIR), "favicon.svg")

    @app.route("/convert", methods=["POST"])
    def convert():
        rate_limit_key = f"ip:{request.remote_addr or 'unknown'}"
        is_allowed, retry_after = convert_rate_limiter.allow(rate_limit_key)
        if not is_allowed:
            response = Response(
                read_partial(
                    "error.html",
                    {
                        "{{ message }}": (
                            "too many conversion requests. please wait and try again."
                        ),
                    },
                ),
                status=429,
                mimetype="text/html",
            )
            response.headers["Retry-After"] = str(retry_after)
            return response

        md = request.form.get("markdown", "").strip()
        if not md:
            return (
                read_partial(
                    "error.html",
                    {
                        "{{ message }}": "Markdown content is required.",
                    },
                ),
                400,
            )

        paper_size = pick_option(
            request.form.get("paper_size", ""),
            "letterpaper",
            VALID_PAPER_SIZES,
        )
        margin = pick_option(
            request.form.get("margin", ""),
            "1in",
            VALID_MARGINS,
        )

        font_family = request.form.get("main_font", "serif")
        if font_family not in ("serif", "sans", "system-ui"):
            font_family = "serif"

        line_spacing = pick_option(
            request.form.get("line_spacing", ""),
            "1",
            VALID_LINE_SPACINGS,
        )
        show_page_numbers = request.form.get("page_numbers") == "on"
        disable_syntax_highlighting = (
            request.form.get("disable_syntax_highlighting") == "on"
        )
        disable_backgrounds = request.form.get("disable_backgrounds") == "on"

        download_name = (
            f"{APP_NAME}_{int(time.time())}_{secrets.token_hex(20)}.pdf"
        )

        ok, pdf_bytes, err = generate_pdf(
            md,
            paper_size,
            margin,
            font_family,
            line_spacing,
            show_page_numbers,
            not disable_syntax_highlighting,
            disable_backgrounds,
        )

        if not ok:
            app.logger.error("pdf generation failed: %s", err)
            return (
                read_partial(
                    "error.html",
                    {
                        "{{ message }}": str(escape(tail_text(err))),
                    },
                ),
                500,
            )

        if err:
            app.logger.warning("pdf generated with fallback renderer: %s", err)

        response = Response(pdf_bytes, mimetype="application/pdf")
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{download_name}"'
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    return app


app = create_app()


if __name__ == "__main__":
    host = os.getenv("HOST", DEFAULT_HOST)
    port = int(os.getenv("PORT", str(DEFAULT_PORT)))
    print(f"  {APP_NAME} listening on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)

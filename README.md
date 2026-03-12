# likha-pdf

a simple web app that converts markdown to pdf.

<img width="1280" height="800" alt="likha-pdf screenshot" src="https://github.com/user-attachments/assets/578b8410-53ad-4323-a45a-19ae3aabe61d" />


## features

- markdown to pdf export
- image upload with markdown snippet insertion
- paper size, margin, font, line spacing, and page number options
- syntax-highlighted code blocks
- always produces a pdf (reportlab fallback if weasyprint fails)

## requirements

- python 3.10+
- system packages: `libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 shared-mime-info`
- gunicorn (installed from `requirements.txt`)

## image usage

1. upload an image from the page
2. click `insert into markdown`
3. generate pdf


## run

### local

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd src/
python3 app.py
```

### production (vps + nginx)

```bash
cd src/
../.venv/bin/gunicorn \
	--bind 127.0.0.1:5001 \
	--worker-class gthread \
	--workers 1 \
	--threads 2 \
	--timeout 240 \
	--graceful-timeout 30 \
	--keep-alive 5 \
	--max-requests 300 \
	--max-requests-jitter 50 \
	--access-logfile - \
	--error-logfile - \
	app:app
```

nginx should reverse proxy to `127.0.0.1:5001` and pass:

- `X-Forwarded-For`
- `X-Forwarded-Proto`
- `X-Forwarded-Host`

### docker

```bash
docker build -t likha-pdf .
docker run -p 5001:5001 likha-pdf
```

open `http://localhost:5001`

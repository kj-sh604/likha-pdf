# likha-pdf

a simple web app that converts markdown to pdf.

<img width="1440" height="1080" alt="likha-pdf screenshot" src="https://github.com/user-attachments/assets/9fa15803-f0da-43d0-8a82-0fc490f3d5ff" />

## features

- markdown to pdf export
- image upload with markdown snippet insertion
- paper size, margin, font, line spacing, and page number options
- syntax-highlighted code blocks
- always produces a pdf (reportlab fallback if weasyprint fails)

## requirements

- python 3.10+
- system packages: `libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 shared-mime-info`

## image usage

1. upload an image from the page
2. click `insert into markdown`
3. generate pdf


## run

### local

```bash
pip install -r requirements.txt
cd src/
python3 app.py
```

### docker

```bash
docker build -t likha-pdf .
docker run -p 5001:5001 likha-pdf
```

open `http://localhost:5001`

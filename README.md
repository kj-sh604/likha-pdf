# likha-pdf

a simple and crappy web app that converts markdown to pdf using pandoc and lualatex.

<img width="1280" height="801" alt="Screen Shot 2026-02-16 at 02 05 37" src="https://github.com/user-attachments/assets/f7154612-20d0-4065-b1c3-90c22c74b8df" />

## features

- markdown to pdf export
- crappy image upload (but it works)
- emoji-capable latex template

## requirements

- python 3.10+
- pandoc
- lualatex

## image usage

1. upload an image from the page
2. click `insert into markdown`
3. generate pdf


## run

### local

```bash
cd src/
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

### docker

```bash
docker build -t likha-pdf .
docker run -p 5000:5000 likha-pdf
```

open `http://localhost:5000`

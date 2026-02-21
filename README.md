# likha-pdf

a simple and crappy web app that converts markdown to pdf using pandoc and lualatex.

<img width="1440" height="1080" alt="likha-pdf screenshot" src="https://github.com/user-attachments/assets/9fa15803-f0da-43d0-8a82-0fc490f3d5ff" />

## features

- markdown to pdf export
- crappy image upload (but it works)
- emoji-capable latex template

## requirements

- nim 1.6+
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
nim c -d:release -o:likha-pdf app.nim
./likha-pdf
```

### docker

```bash
docker build -t likha-pdf .
docker run -p 5000:5000 likha-pdf
```

open `http://localhost:5000`

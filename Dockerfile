FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    nim \
    build-essential \
    pandoc \
    texlive-full \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src/ .

RUN nim c -d:release --opt:size -o:likha-pdf app.nim

RUN mkdir -p generated uploads

EXPOSE 5000

CMD ["./likha-pdf"]

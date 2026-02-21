import std/[asynchttpserver, asyncdispatch, os, osproc, streams, strutils, tables, times, uri, random]

# tiny backend in nimlang, may be stupid, but this was fun

const
  AllowedImageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
  ValidPaperSizes = [
    "a0paper", "a1paper", "a2paper", "a3paper", "a4paper", "a5paper", "a6paper",
    "b0paper", "b1paper", "b2paper", "b3paper", "b4paper", "b5paper", "b6paper",
    "c4paper", "c5paper", "c6paper",
    "letterpaper", "legalpaper", "executivepaper", "ledgerpaper",
    "tabloid", "statement", "flsa"
  ]
  ValidMargins = ["0.75in", "1in", "1.25in", "1.5in"]
  ValidLineSpacings = ["1", "1.5", "2"]
  CustomPaperDimensions = [
    ("tabloid",   "11in",  "17in"),
    ("statement", "5.5in", "8.5in"),
    ("flsa",      "8.5in", "13in"),
  ]

const
  AppName = "likha-pdf"

proc lookupCustomPaper(name: string): tuple[width: string, height: string] =
  for (paperName, w, h) in CustomPaperDimensions:
    if paperName == name:
      return (width: w, height: h)
  (width: "", height: "")

proc baseDir(): string {.inline.} =
  getAppDir()

proc generatedDir(): string {.inline.} =
  baseDir() / "generated"

proc uploadsDir(): string {.inline.} =
  baseDir() / "uploads"

proc latexTemplatePath(): string {.inline.} =
  baseDir() / "latex" / "template.tex"

proc templatesDir(): string {.inline.} =
  baseDir() / "templates"

proc partialsDir(): string {.inline.} =
  templatesDir() / "partials"

proc staticDir(): string {.inline.} =
  baseDir() / "static"

type MultipartPart = object
  name: string
  filename: string
  contentType: string
  content: string

# helpers
proc htmlEscape(value: string): string =
  result = value
  result = result.replace("&", "&amp;")
  result = result.replace("<", "&lt;")
  result = result.replace(">", "&gt;")
  result = result.replace("\"", "&quot;")
  result = result.replace("'", "&#39;")

proc randomHex(length: int): string =
  const hexChars = "0123456789abcdef"
  result = newStringOfCap(length)
  for _ in 0 ..< length:
    result.add(hexChars[rand(15)])

proc renderTemplate(filePath: string; replacements: openArray[(string, string)]): string =
  result = readFile(filePath)
  for (token, replacement) in replacements:
    result = result.replace(token, replacement)

proc decodeFormComponent(value: string): string =
  decodeUrl(value.replace("+", " "))

proc parseUrlEncoded(body: string): Table[string, string] =
  result = initTable[string, string]()
  if body.len == 0:
    return

  for pair in body.split("&"):
    if pair.len == 0:
      continue
    let separator = pair.find('=')
    if separator < 0:
      result[decodeFormComponent(pair)] = ""
    else:
      let key = decodeFormComponent(pair[0 ..< separator])
      let value = decodeFormComponent(pair[separator + 1 .. ^1])
      result[key] = value

# "options" are optional, defaults are forever.
proc pickOption(value: string; fallback: string; options: openArray[string]): string =
  for option in options:
    if option == value:
      return value
  fallback

proc sanitizeFilename(filename: string): string =
  result = newStringOfCap(filename.len)
  for ch in filename:
    if (ch >= 'a' and ch <= 'z') or
       (ch >= 'A' and ch <= 'Z') or
       (ch >= '0' and ch <= '9') or
       (ch in {'-', '_', '.'}):
      result.add(ch)
    elif ch == ' ':
      result.add('_')

proc baseFilename(value: string): string =
  var normalized = value.replace("\\", "/")
  let index = normalized.rfind('/')
  if index >= 0 and index < normalized.high:
    normalized = normalized[index + 1 .. ^1]
  elif index == normalized.high:
    normalized = ""
  normalized

proc isAllowedImage(filename: string): bool =
  let dot = filename.rfind('.')
  if dot < 1 or dot == filename.high:
    return false
  let extension = filename[dot + 1 .. ^1].toLowerAscii()
  for allowed in AllowedImageExtensions:
    if extension == allowed:
      return true
  false

proc tailText(value: string; maxLen: int = 1200): string =
  if value.len <= maxLen:
    return value
  value[value.len - maxLen .. ^1]

proc extractBoundary(contentType: string): string =
  for part in contentType.split(';'):
    let token = part.strip()
    if token.toLowerAscii().startsWith("boundary="):
      return token[9 .. ^1].strip(chars = {'\"', '\''})
  ""

proc stripTrailingCrlf(value: string): string =
  result = value
  if result.len >= 2 and result.endsWith("\r\n"):
    result.setLen(result.len - 2)

# hand-rolled multipart parsing, yes i am aware that this is "eh"
proc parseMultipart(body: string; boundary: string): seq[MultipartPart] =
  let delimiter = "--" & boundary
  for rawChunk in body.split(delimiter):
    var chunk = rawChunk
    if chunk.len == 0:
      continue
    if chunk == "--" or chunk == "--\r\n":
      continue
    if chunk.startsWith("\r\n"):
      chunk = chunk[2 .. ^1]

    chunk = stripTrailingCrlf(chunk)

    if chunk.len == 2 and chunk == "--":
      continue

    let splitIndex = chunk.find("\r\n\r\n")
    if splitIndex < 0:
      continue

    let headerBlock = chunk[0 ..< splitIndex]
    var content = chunk[splitIndex + 4 .. ^1]
    content = stripTrailingCrlf(content)

    var name = ""
    var filename = ""
    var contentType = "application/octet-stream"

    for line in headerBlock.split("\r\n"):
      let separator = line.find(':')
      if separator <= 0:
        continue
      let headerName = line[0 ..< separator].strip().toLowerAscii()
      let headerValue = line[separator + 1 .. ^1].strip()

      if headerName == "content-disposition":
        for part in headerValue.split(';'):
          let token = part.strip()
          if token.startsWith("name="):
            name = token[5 .. ^1].strip(chars = {'\"', '\''})
          elif token.startsWith("filename="):
            filename = token[9 .. ^1].strip(chars = {'\"', '\''})
      elif headerName == "content-type":
        contentType = headerValue

    if name.len > 0:
      result.add(MultipartPart(name: name, filename: filename, contentType: contentType, content: content))

proc isSafeRelativePath(pathPart: string): bool =
  pathPart.len > 0 and
  not pathPart.contains("..") and
  not pathPart.contains('\\') and
  not pathPart.startsWith("/")

proc fileContentType(filePath: string): string =
  let lowered = filePath.toLowerAscii()
  if lowered.endsWith(".js"):
    return "application/javascript; charset=utf-8"
  if lowered.endsWith(".css"):
    return "text/css; charset=utf-8"
  if lowered.endsWith(".html"):
    return "text/html; charset=utf-8"
  if lowered.endsWith(".png"):
    return "image/png"
  if lowered.endsWith(".jpg") or lowered.endsWith(".jpeg"):
    return "image/jpeg"
  if lowered.endsWith(".gif"):
    return "image/gif"
  if lowered.endsWith(".webp"):
    return "image/webp"
  if lowered.endsWith(".svg"):
    return "image/svg+xml"
  if lowered.endsWith(".pdf"):
    return "application/pdf"
  "application/octet-stream"

# response wrappers
proc respondHtml(req: Request; code: HttpCode; content: string) {.async.} =
  let headers = newHttpHeaders({"Content-Type": "text/html; charset=utf-8"})
  await req.respond(code, content, headers)

proc respondText(req: Request; code: HttpCode; content: string) {.async.} =
  let headers = newHttpHeaders({"Content-Type": "text/plain; charset=utf-8"})
  await req.respond(code, content, headers)

proc respondFile(req: Request; filePath: string; asAttachment: bool = false; attachmentName: string = "") {.async.} =
  if not fileExists(filePath):
    await respondText(req, Http404, "Not found")
    return

  var headers = newHttpHeaders()
  headers["Content-Type"] = fileContentType(filePath)
  if asAttachment and attachmentName.len > 0:
    headers["Content-Disposition"] = "attachment; filename=\"" & attachmentName & "\""

  await req.respond(Http200, readFile(filePath), headers)

# pandoc does the heavy lifting
proc runPandoc(sourceMarkdown: string; outputPath: string; paperSize: string; margin: string; mainFont: string; lineSpacing: string; showPageNumbers: bool): tuple[ok: bool, output: string, missingPandoc: bool] =
  let tempDir = getTempDir() / (AppName & "-" & randomHex(10))
  createDir(tempDir)
  let tempMarkdownPath = tempDir / "source.md"
  let tempRawPath = tempDir / "raw.md"

  try:
    # write raw markdown first
    writeFile(tempRawPath, sourceMarkdown)

    # preprocess markdown: convert to ascii with transliteration and normalize quotes
    let iconvCmd = "iconv -c -t ASCII//TRANSLIT " & quoteShell(tempRawPath) & " | sed 's/'\\''/'/g; s/\"\"/\"/g' > " & quoteShell(tempMarkdownPath)
    let (iconvOutput, iconvExitCode) = execCmdEx(iconvCmd)

    if iconvExitCode != 0:
      # if preprocessing fails, fall back to original content
      writeFile(tempMarkdownPath, sourceMarkdown)

    var args = @[
      tempMarkdownPath,
      "--from", "markdown+emoji+hard_line_breaks",
      "--pdf-engine=lualatex",
      "--template", latexTemplatePath(),
      "-V", "margin=" & margin,
      "-V", "mainfont=" & mainFont,
      "-V", "linespacing=" & lineSpacing,
      "--resource-path", baseDir() & ":" & uploadsDir() & ":" & tempDir,
      "-o", outputPath
    ]

    let dims = lookupCustomPaper(paperSize)
    if dims.width.len > 0:
      args.add("-V")
      args.add("paperwidth=" & dims.width)
      args.add("-V")
      args.add("paperheight=" & dims.height)
    else:
      args.add("-V")
      args.add("papersize=" & paperSize)

    if not showPageNumbers:
      args.add("-V")
      args.add("hidepages=true")

    var process: Process
    try:
      process = startProcess("pandoc", args = args, options = {poUsePath, poStdErrToStdOut})
    except OSError:
      return (ok: false, output: "Pandoc is not installed or not in PATH.", missingPandoc: true)

    let output = process.outputStream.readAll()
    let exitCode = process.waitForExit()
    process.close()

    if exitCode == 0:
      return (ok: true, output: "", missingPandoc: false)
    return (ok: false, output: output, missingPandoc: false)
  finally:
    try:
      if fileExists(tempRawPath):
        removeFile(tempRawPath)
      if fileExists(tempMarkdownPath):
        removeFile(tempMarkdownPath)
      if dirExists(tempDir):
        removeDir(tempDir)
    except OSError:
      discard

# app endpoint: strict inputs, loud errors.
proc handleConvert(req: Request) {.async.} =
  let formData = parseUrlEncoded(req.body)
  let markdown = formData.getOrDefault("markdown", "").strip()

  if markdown.len == 0:
    let html = renderTemplate(partialsDir() / "error.html", [("{{ message }}", "Markdown content is required.")])
    await respondHtml(req, Http400, html)
    return

  let paperSize = pickOption(formData.getOrDefault("paper_size", ""), "a4paper", ValidPaperSizes)
  let margin = pickOption(formData.getOrDefault("margin", ""), "1in", ValidMargins)

  var mainFontFamily = formData.getOrDefault("main_font", "serif")
  if mainFontFamily != "serif" and mainFontFamily != "sans":
    mainFontFamily = "serif"

  let mainFont = if mainFontFamily == "sans": "TeX Gyre Heros" else: "TeX Gyre Pagella"
  let lineSpacing = pickOption(formData.getOrDefault("line_spacing", ""), "1", ValidLineSpacings)
  let showPageNumbers = formData.getOrDefault("page_numbers", "") == "on"
  let epoch = int(getTime().toUnix())
  let outputName = AppName & "_" & $epoch & "_" & randomHex(32) & ".pdf"
  let outputPath = generatedDir() / outputName

  let conversion = runPandoc(markdown, outputPath, paperSize, margin, mainFont, lineSpacing, showPageNumbers)

  if not conversion.ok:
    let message = if conversion.missingPandoc:
      conversion.output
    else:
      let stderr = conversion.output.strip()
      if stderr.len > 0: tailText(stderr) else: "PDF conversion failed."

    let html = renderTemplate(partialsDir() / "error.html", [("{{ message }}", htmlEscape(message))])
    let code = if conversion.missingPandoc: Http500 else: Http400
    await respondHtml(req, code, html)
    return

  let html = renderTemplate(
    partialsDir() / "result.html",
    [
      ("{{ filename }}", htmlEscape(outputName)),
      ("{{ download_url }}", "/download/" & encodeUrl(outputName))
    ]
  )
  await respondHtml(req, Http200, html)

# upload endpoint. accepts image, returns markdown snippet
proc handleUploadImage(req: Request) {.async.} =
  let contentType = req.headers.getOrDefault("Content-Type")
  let boundary = extractBoundary(contentType)

  if boundary.len == 0:
    let html = renderTemplate(partialsDir() / "upload_error.html", [("{{ message }}", "image file is required.")])
    await respondHtml(req, Http400, html)
    return

  let parts = parseMultipart(req.body, boundary)
  var imagePart: MultipartPart
  var foundImage = false
  for part in parts:
    if part.name == "image":
      imagePart = part
      foundImage = true
      break

  if not foundImage or imagePart.filename.strip().len == 0:
    let html = renderTemplate(partialsDir() / "upload_error.html", [("{{ message }}", "image file is required.")])
    await respondHtml(req, Http400, html)
    return

  let originalName = sanitizeFilename(baseFilename(imagePart.filename))
  if originalName.len == 0 or not isAllowedImage(originalName):
    let html = renderTemplate(partialsDir() / "upload_error.html", [("{{ message }}", "unsupported image type.")])
    await respondHtml(req, Http400, html)
    return

  let extensionStart = originalName.rfind('.')
  let extension = originalName[extensionStart + 1 .. ^1].toLowerAscii()

  let epoch = int(getTime().toUnix())
  let storedName = "img_" & $epoch & "_" & randomHex(32) & "." & extension
  let imagePath = uploadsDir() / storedName

  writeFile(imagePath, imagePart.content)

  let markdownSnippet = "![](uploads/" & storedName & ")"
  let html = renderTemplate(
    partialsDir() / "upload_result.html",
    [
      ("{{ filename }}", htmlEscape(storedName)),
      ("{{ markdown_snippet }}", htmlEscape(markdownSnippet)),
      ("{{ preview_url }}", "/uploads/" & encodeUrl(storedName))
    ]
  )
  await respondHtml(req, Http200, html)

# router table
proc route(req: Request) {.async.} =
  let path = req.url.path

  if req.reqMethod == HttpGet and path == "/":
    await respondFile(req, templatesDir() / "index.html")
    return

  if req.reqMethod == HttpGet and path.startsWith("/static/"):
    let relativePath = decodeUrl(path[8 .. ^1])
    if not isSafeRelativePath(relativePath):
      await respondText(req, Http400, "Invalid path")
      return
    await respondFile(req, staticDir() / relativePath)
    return

  if req.reqMethod == HttpGet and path.startsWith("/uploads/"):
    let relativePath = decodeUrl(path[9 .. ^1])
    if not isSafeRelativePath(relativePath):
      await respondText(req, Http400, "Invalid path")
      return
    await respondFile(req, uploadsDir() / relativePath)
    return

  if req.reqMethod == HttpGet and path.startsWith("/download/"):
    let relativePath = decodeUrl(path[10 .. ^1])
    if not isSafeRelativePath(relativePath):
      await respondText(req, Http400, "Invalid path")
      return
    await respondFile(req, generatedDir() / relativePath, asAttachment = true, attachmentName = relativePath)
    return

  if req.reqMethod == HttpPost and path == "/convert":
    await handleConvert(req)
    return

  if req.reqMethod == HttpPost and path == "/upload-image":
    await handleUploadImage(req)
    return

  await respondText(req, Http404, "Not found")

# server boot, then we let htmx do htmx things.
when isMainModule:
  randomize()

  if not dirExists(generatedDir()):
    createDir(generatedDir())
  if not dirExists(uploadsDir()):
    createDir(uploadsDir())

  let server = newAsyncHttpServer()
  echo "listening on http://localhost:5000"
  waitFor server.serve(Port(5000), route)
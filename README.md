# BDConverter

A lightweight web service to convert PDF files into comic-book archives (CBZ/CBR/CB7/CBT). Provides a small web UI and a REST API for batch conversions, progressive thumbnails and flexible image/archive options.

About
-------
BDConverter uses Poppler utilities (pdftoppm, pdfimages, pdfinfo) to render or extract images from PDFs and packages the result into one of the comic archive formats (CBZ, CBT, CB7, CBR). The official Dockerfile installs system dependencies so the container can run the conversion tools out-of-the-box.

Features
--------
- Convert PDF → CBZ / CBT / CB7 / CBR
- Render mode (pdftoppm): control DPI, image format (jpeg/png/tiff), JPEG quality, color mode
- Original mode (pdfimages -all): extract native images without recompression
- Real-time progress updates via Server-Sent Events (SSE) at /events
- Progressive thumbnail generation and a final base64-encoded thumbnail per result
- Persistent output directory configurable via environment variable

Quick start
-----------
run locally (example):

```bash
docker run -d \
--name=BDConverter \
-p 3111:3111 \
-v 'path'/output:/app/output \
-v 'path'/upload:/app/upload \
--restart unless-stopped \
fuzzzor/bdconverter:latest
```
Change 'path' with your real host

Open http://localhost:3111 in your browser.

Docker Compose example
----------------------
A minimal `docker-compose.yml` for BDConverter:

[`yaml()`](Dockerfile:1)
```yaml
version: "3.8"
services:
  bdconverter:
    image: fuzzzor/bdconverter:latest
    container_name: BDConverter   
    ports:
      - "3111:3111"
    environment:
      - FEATURE_PROGRESS_THUMBNAIL=1
    volumes:
      - ./output:/app/output
      - ./upload:/app/upload #(optional)
    restart: unless-stopped
```

Environment variables
---------------------
- `PORT` — HTTP port (default: 3111)
- `UPLOAD_DIR` — temporary upload directory (default: ./upload)
- `TEMP_DIR` — temporary work directory (default: ./temp)
- `OUTPUT_DIR` — persistent output directory for converted file(s) (default: ./output)
- `FEATURE_PROGRESS_THUMBNAIL` — set to `0` to disable progressive thumbnails (default: enabled)

Volumes and persistence
-----------------------
Bind a host folder to `/app/output` (or set `OUTPUT_DIR`) to keep generated archives between container runs. Also bind a folder to `/app/upload` if you want to reuse uploaded files across restarts.

Security
--------
This app performs file processing on uploaded PDFs. Run the service behind a reverse proxy if exposing to the public internet. Consider resource limits (CPU, memory) and volume quotas to avoid abuse.


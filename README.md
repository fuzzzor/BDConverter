# BDConverter
<img src="https://raw.githubusercontent.com/fuzzzor/BDConverter/refs/heads/main/icons/conv.png" height="120" />

A lightweight web service to convert PDF files into comic-book archives (CBZ/CBR/CB7/CBT). Provides a small web UI and a REST API for batch conversions, progressive thumbnails and flexible image/archive options.

About
-------
BDConverter uses Poppler utilities (pdftoppm, pdfimages, pdfinfo) to render or extract images from PDFs and packages the result into one of the comic archive formats (CBZ, CBT, CB7, CBR). The official Dockerfile installs system dependencies so the container can run the conversion tools out-of-the-box.

Features
--------
- Convert PDF → CBZ / CBT / CB7 / CBR
- **Batch conversion** of folders: Drop multiple folders to create one archive per folder.
- **Merge mode**: Drop multiple standalone images to merge them into a single archive.
- **Themeable UI**: Choose between `default` and `neon` themes via environment variable.
- **Image Processing**:
  - Automatic conversion of WEBP/BMP to JPG (preserving quality settings).
  - Smart resizing when DPI is specified.
  - **Auto-Split Double Pages**: Automatically detects landscape scans (width > height * 1.2) and splits them into two vertical pages. Supports Left-to-Right (Comics) and Right-to-Left (Manga) reading directions.
- **New Output Formats**:
  - CBR (RAR4) for legacy compatibility.
  - Directory (Folder extraction) to extract images without archiving.
- Render mode (pdftoppm): control DPI, image format (jpeg/png/tiff), JPEG quality, color mode.
- Original mode (pdfimages -all): extract native images without recompression.
- Real-time progress updates via Server-Sent Events (SSE) at /events.
- Progressive thumbnail generation and a final base64-encoded thumbnail per result.
- Persistent output directory configurable via environment variable.

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
      - THEME=default  # or 'neon' for cyberpunk style
      - FEATURE_PROGRESS_THUMBNAIL=1
      - LOGS=info  # or 'debug' for detailed logs
    volumes:
      - ./output:/app/output
      - ./upload:/app/upload #(optional)
    restart: unless-stopped
```

Environment variables
---------------------
- `PORT` — HTTP port (default: 3111)
- `THEME` — UI theme: `default`, `neon`, or `terminal` (default: default)
- `UPLOAD_DIR` — temporary upload directory (default: ./upload)
- `TEMP_DIR` — temporary work directory (default: ./temp)
- `OUTPUT_DIR` — persistent output directory for converted file(s) (default: ./output)
- `FEATURE_PROGRESS_THUMBNAIL` — set to `0` to disable progressive thumbnails (default: enabled)
- `LOGS` — Log level: `info` (default, shows task start/end) or `debug` (detailed image-by-image logs)

Themes
------
BDConverter supports multiple visual themes that can be selected via the `THEME` environment variable or switched live with **Shift+F12**:

- **default**: Clean dark theme with orange accents - Professional and easy on the eyes (Card-style layout, 500px width)
- **neon**: Cyberpunk-inspired theme with cyan/magenta neon glows and pulsing animations - Retro-futuristic style (Card-style layout)
- **terminal**: Hacker/developer theme with monospace font, grid background, and cyan accents - Terminal-inspired aesthetic (Flat layout, 820px width)
- **white**: Light professional theme with blue accents on light gray background - Clean and modern for daytime use (Flat layout, 820px width)

### Setting a theme

Via environment variable in docker-compose.yml:
```yaml
environment:
  - THEME=terminal
```

Or when running locally:
```bash
# Windows
set THEME=neon
node server.js

# Linux/Mac
THEME=neon node server.js
```

### Switching themes on-the-fly

Once the application is running, you can switch between themes without restarting:
- Press **Shift+F12** to cycle through all available themes
- Click the theme indicator button in the bottom-left corner
- Your theme preference is saved in browser localStorage and persists across sessions

Themes are loaded dynamically, so switching is instant without page reload!

Volumes and persistence
-----------------------
Bind a host folder to `/app/output` (or set `OUTPUT_DIR`) to keep generated archives between container runs. Also bind a folder to `/app/upload` if you want to reuse uploaded files across restarts.

Security
--------
This app performs file processing on uploaded PDFs. Run the service behind a reverse proxy if exposing to the public internet. Consider resource limits (CPU, memory) and volume quotas to avoid abuse.


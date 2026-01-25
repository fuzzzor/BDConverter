const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');

const app = express();
const port = process.env.PORT || 3111;

// Middleware to parse JSON payloads (required for client-side logs)
app.use(express.json());

// SSE connections storage
const activeConnections = {};

// Directory configuration (supports environment variables for Docker)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'upload');
const TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp');

// Ensure required directories exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Multer configuration
const upload = multer({ dest: UPLOAD_DIR });

// Serve static frontend files
app.use(express.static(__dirname));

// Expose application version (package.json)
const pkg = require('./package.json');
app.get('/version', (req, res) => {
    res.json({ version: pkg.version });
});

const isWin = process.platform === "win32";

// Executable paths depending on OS
const popplerPath = isWin ? path.join(__dirname, 'bin', 'pdftoppm.exe') : 'pdftoppm';
const pdfimagesPath = isWin ? path.join(__dirname, 'bin', 'pdfimages.exe') : 'pdfimages';
const pdfinfoPath = isWin ? path.join(__dirname, 'bin', 'pdfinfo.exe') : 'pdfinfo';

// Poppler availability check at startup
const checkTool = isWin ? popplerPath : 'pdftoppm';
if (isWin) {
    if (!fs.existsSync(popplerPath)) {
        console.error(`❌ CRITICAL ERROR: Poppler not found in bin/ directory`);
    } else {
        console.log(`✅ Poppler detected (Windows)`);
    }
} else {
    execFile(checkTool, ['-v'], (error) => {
        if (error) {
            console.error(`❌ CRITICAL ERROR: Poppler is not installed.`);
            console.error(`   On Debian/Ubuntu, install it with: apt-get install poppler-utils`);
        } else {
            console.log(`✅ Poppler detected (Linux)`);
        }
    });
}

// Progressive thumbnail UI feature flag
// Enabled by default (can be disabled with FEATURE_PROGRESS_THUMBNAIL=0)
const FEATURE_PROGRESS_THUMBNAIL = process.env.FEATURE_PROGRESS_THUMBNAIL !== '0';

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// SSE endpoint for progress updates
app.get('/events', (req, res) => {
    const requestId = req.query.requestId;
    if (!requestId) return res.status(400).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    console.log(`[DEBUG] SSE connection registered for ID: ${requestId}`);
    activeConnections[requestId] = res;

    req.on('close', () => {
        delete activeConnections[requestId];
    });
});

// Endpoint to receive client-side UI logs
app.post('/client-log', (req, res) => {
    const { message } = req.body;
    if (message) {
        console.log(`[UI] ${message}`);
    }
    res.sendStatus(200);
});

function sendProgress(requestId, data) {
    if (activeConnections[requestId]) {
        activeConnections[requestId].write(`data: ${JSON.stringify(data)}\n\n`);
    } else {
        console.warn(`[DEBUG] No active SSE connection for ID: ${requestId}. Event dropped: ${data.type}`);
    }
}

// Helper to get PDF page count (Linux/Windows compatible)
function getPageCount(filePath) {
    return new Promise((resolve) => {
        execFile(pdfinfoPath, [filePath], (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const match = stdout.match(/Pages:\s+(\d+)/);
            resolve(match ? parseInt(match[1]) : null);
        });
    });
}

// (removed) duplicated /client-log endpoint — already defined above

// Route principale de conversion
app.post('/convert', upload.array('files'), async (req, res) => {
    const { dpi, colorMode, pageStart, pageEnd, format, compression, archiveCompression, imgFormat, requestId } = req.body;
    const isOriginal = dpi === 'original';
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    // Original mode: no rendering, pdfimages only
    const dpiVal = isOriginal ? null : (dpi ? parseInt(dpi) : 225);
    const compVal = compression ? parseInt(compression) : 80;
    const archCompVal = archiveCompression !== undefined ? parseInt(archiveCompression) : 5;

    try {
        sendProgress(requestId, { type: 'log', message: `Received ${files.length} file(s).` });
        
        const results = [];
        for (const [index, file] of files.entries()) {
            // Fix encoding for special characters (Mojibake fix)
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

            sendProgress(requestId, {
                type: 'progress',
                currentFileIndex: index + 1,
                totalFiles: files.length,
                totalPct: Math.round((index / files.length) * 100),
                currentFileName: file.originalname,
                currentPct: 0,
                status: `Analyzing ${file.originalname}...`
            });

            // Ensure input file has .pdf extension (helps some tools like pdftoppm)
            if (!file.path.toLowerCase().endsWith('.pdf')) {
                const newPath = file.path + '.pdf';
                try {
                    fs.renameSync(file.path, newPath);
                    file.path = newPath;
                } catch (err) {
                    console.error("Error renaming input file:", err);
                }
            }

            // Base PDF filename (strip optional technical suffix _timestamp_uuid)
            let fileName = path.parse(file.originalname).name;
            fileName = fileName.replace(/_\d{13}_[a-f0-9\-]{36}$/i, '');
            const tempDir = path.join(__dirname, 'upload', fileName + "_temp_" + Date.now());
            fs.mkdirSync(tempDir, { recursive: true });

            const outputPrefix = path.join(tempDir, 'page');
            
            // 1. Detect total pages for progress tracking
            const totalPages = await getPageCount(file.path);
            
            // Compute actual number of pages to convert (if range is defined)
            let effectiveTotalPages = totalPages;
            if (totalPages) {
                const pStart = pageStart ? parseInt(pageStart) : 1;
                const pEnd = pageEnd ? parseInt(pageEnd) : totalPages;
                const actualStart = Math.max(1, pStart);
                const actualEnd = Math.min(totalPages, pEnd);
                if (actualEnd >= actualStart) {
                    effectiveTotalPages = actualEnd - actualStart + 1;
                }
            }
            sendProgress(requestId, { type: 'log', message: `Pages detected: ${totalPages || 'Unknown'} (Target: ${effectiveTotalPages})` });

            // 2. Command preparation
            let args = [];
            let tool = popplerPath;
            const safeImgFormat = (imgFormat || 'jpeg').toLowerCase();
            
            if (isOriginal) {
                // ✅ ORIGINAL MODE: full native extraction
                // -all ensures pdfimages extracts everything and exits correctly
                tool = pdfimagesPath;
                args = ['-all'];

                if (pageStart) args.push('-f', pageStart);
                if (pageEnd) args.push('-l', pageEnd);

                console.log('[DEBUG] ORIGINAL MODE ENABLED - Using pdfimages -all');

                args.push(file.path, outputPrefix);
            } else {
                // Render mode (pdftoppm)
                tool = popplerPath;
                args = ['-r', dpiVal.toString()];
                
                // Configuration format...
                if (safeImgFormat === 'png') {
                    args.push('-png');
                    if (colorMode === 'gray') args.push('-gray');
                    if (colorMode === 'mono') args.push('-mono');
                } else if (safeImgFormat === 'tiff') {
                    args.push('-tiff');
                    if (colorMode === 'gray') args.push('-gray');
                    if (colorMode === 'mono') args.push('-mono');
                } else {
                    args.push('-jpeg');
                    if (compression) args.push('-jpegopt', `quality=${compVal}`);
                    if (colorMode === 'gray' || colorMode === 'mono') args.push('-gray');
                }

                if (pageStart) args.push('-f', pageStart);
                if (pageEnd) args.push('-l', pageEnd);
                
                console.log('[DEBUG] DPI MODE ENABLED - Using pdftoppm with rendering');

                args.push(file.path, outputPrefix);
            }

            console.log(`[DEBUG] CMD: "${tool}" ${args.join(' ')}`);
            // Send progress thumbnail to UI
            if (FEATURE_PROGRESS_THUMBNAIL) {
                try {
                    const colorPrefix = path.join(tempDir, 'thumb_color');

                    // ✅ Original mode: immediate static thumbnail (no animation)
                    if (isOriginal) {
                        execFile(popplerPath, ['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix], () => {
                            const colorFile = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                            if (!colorFile) return;
                            const colorB64 = fs.readFileSync(path.join(tempDir, colorFile)).toString('base64');
                            sendProgress(requestId, {
                                type: 'thumbnail-init',
                                color: `data:image/jpeg;base64,${colorB64}`
                            });
                        });
                    } else {
                        // Render mode: animated progressive thumbnail
                        const grayPrefix = path.join(tempDir, 'thumb_gray');
                        execFile(popplerPath, ['-jpeg', '-gray', '-scale-to', '200', '-f', '1', '-l', '1', file.path, grayPrefix], () => {
                            const grayFile = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_gray') && f.endsWith('.jpg'));
                            if (!grayFile) return;
                            const grayB64 = fs.readFileSync(path.join(tempDir, grayFile)).toString('base64');
                            execFile(popplerPath, ['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix], () => {
                                const colorFile = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                                if (!colorFile) return;
                                const colorB64 = fs.readFileSync(path.join(tempDir, colorFile)).toString('base64');
                                sendProgress(requestId, {
                                    type: 'thumbnail-init',
                                    gray: `data:image/jpeg;base64,${grayB64}`,
                                    color: `data:image/jpeg;base64,${colorB64}`
                                });
                            });
                        });
                    }
                } catch (e) {
                    console.error('Progress thumbnail error:', e);
                }
            }
            
            sendProgress(requestId, { type: 'log', message: `Conversion in progress (${isOriginal ? 'Extraction' : 'Rendering'})...` });

            // 3. Progress tracking (directory polling)
            let progressInterval = null;
            if (totalPages) {
                progressInterval = setInterval(() => {
                    try {
                        const filesInDir = fs.readdirSync(tempDir);
                        // Comptage UNIQUEMENT des pages converties (images pageXXX.*)
                        // pdftoppm génère des fichiers du type page-1.jpg, page-0001.jpg, etc.
                        const pageImages = filesInDir.filter(f => /^page[-_]?(\d+).*(jpg|jpeg|png|tif|tiff|bmp)$/i.test(f));
                        const currentPages = pageImages.length;
                        const progress = effectiveTotalPages
                            ? Math.min(100, Math.round((currentPages / effectiveTotalPages) * 100))
                            : 0;
                        sendProgress(requestId, {
                            type: 'progress',
                            currentFileIndex: index + 1,
                            totalFiles: files.length,
                            currentPct: progress,
                            currentPages: currentPages,
                            totalPages: effectiveTotalPages
                        });
                    } catch (e) { /* ignore */ }
                }, 1000);
            }

            // 4. Exécution
            await new Promise((resolve, reject) => {
                // Increase timeout to 30 minutes (1800000 ms) for large PDFs
                const options = { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 };
                execFile(tool, args, options, (error, stdout, stderr) => {
                    if (progressInterval) clearInterval(progressInterval);
                    if (error) {
                        console.error("Erreur exec:", error);
                        if (stderr) {
                            console.error("STDERR:", stderr);
                            error.stderr = stderr;
                        }
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            sendProgress(requestId, {
                type: 'progress',
                currentFileIndex: index + 1,
                totalFiles: files.length,
                currentPct: 100,
                currentPages: effectiveTotalPages,
                totalPages: effectiveTotalPages,
                status: "Assembling..."
            });

            // 5. Scan generated images
            let imgFiles = fs.readdirSync(tempDir);
            
            // STRICT filter: page images only, exclude thumbnails (thumb_*)
            const validExts = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'];
            imgFiles = imgFiles.filter(f => {
                const extOk = validExts.includes(path.extname(f).toLowerCase());
                const isThumb = /^thumb_/i.test(f);
                return extOk && !isThumb;
            });
            
            // Numeric sort
            imgFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

            if (imgFiles.length === 0) {
                throw new Error(`No images generated for ${file.originalname}`);
            }

            // Rename files on disk for archiving
            // ⚠️ IMPORTANT: imgFiles may include non-page images (pdfimages case)
            // effectiveTotalPages is the functional source of truth
            const padding = effectiveTotalPages.toString().length;
            imgFiles.slice(0, effectiveTotalPages).forEach((f, index) => {
                const num = (index + 1).toString().padStart(Math.max(3, padding), '0');
                const newName = `${num}${path.extname(f)}`;
                fs.renameSync(path.join(tempDir, f), path.join(tempDir, newName));
            });

            // Output name = original PDF name (without suffix)
            const outputFileName = `${fileName}.${format || 'cbz'}`;
            // Generate archive in TEMP_DIR before final copy
            const outputPath = path.join(TEMP_DIR, outputFileName);
            
            // Archive creation based on selected format
            // Strict archive format validation
            const allowedFormats = ['cbz', 'cbt', 'cb7', 'cbr'];
            const safeFormat = allowedFormats.includes(format) ? format : 'cbz';
            
            // ✅ ORIGINAL MODE: archive without recompression (identical size)
            if (isOriginal) {
                // Pure storage, no recompression
                await new Promise((resolve, reject) => {
                    exec(`7z a -tzip -mx=0 "${outputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else if (safeFormat === 'cbt') {
                // TAR format
                await new Promise((resolve, reject) => {
                    exec(`tar -cf "${outputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else if (safeFormat === 'cb7') {
                // 7Z format
                await new Promise((resolve, reject) => {
                    // Note: '7z' doit être dans le PATH. Sur Docker/Linux, c'est installé via p7zip-full.
                    // Sur Windows, si 7z n'est pas dans le PATH, cela échouera.
                    exec(`7z a -t7z -mx=${archCompVal} "${outputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else if (safeFormat === 'cbr') {
                // RAR format (native)
                // Map compression level (0-9) to RAR levels (0-5)
                let rarComp = 3; // Default Normal
                if (archCompVal === 0) rarComp = 0;
                else if (archCompVal === 1) rarComp = 1;
                else if (archCompVal === 3) rarComp = 2;
                else if (archCompVal === 5) rarComp = 3;
                else if (archCompVal === 7) rarComp = 4;
                else if (archCompVal === 9) rarComp = 5;

                await new Promise((resolve, reject) => {
                    // Uses 'rar' (proprietary) which must be installed
                    // -r : recursive (content is flat here)
                    // -m : compression level
                    // -ep1 : exclude root folder from archived paths
                    exec(`rar a -r -m${rarComp} -ep1 "${outputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                // CBZ format (now using 7z instead of AdmZip)
                await new Promise((resolve, reject) => {
                    // -tzip force le format ZIP
                    exec(`7z a -tzip -mx=${archCompVal} "${outputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            // Copy to persistent output directory
            const persistentPath = path.join(OUTPUT_DIR, outputFileName);
            fs.copyFileSync(outputPath, persistentPath);
            const finalSize = fs.statSync(persistentPath).size;
            console.log(`[INFO] File saved to: ${persistentPath} (${finalSize} bytes)`);

            // ✅ Generate final thumbnail (ALL MODES, including Original)
            let thumbnail = null;
            try {
                const thumbPrefix = path.join(tempDir, 'thumb_gen');
                await new Promise((resolve, reject) => {
                    execFile(popplerPath, ['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, thumbPrefix], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });
                const thumbFile = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_gen') && f.endsWith('.jpg'));
                if (thumbFile) {
                    const b64 = fs.readFileSync(path.join(tempDir, thumbFile)).toString('base64');
                    thumbnail = `data:image/jpeg;base64,${b64}`;
                }
            } catch (e) {
                console.error("Thumbnail generation error:", e);
            }

            // Cleanup temporary directory and uploaded PDF file
            fs.rmSync(tempDir, { recursive: true, force: true });
            fs.unlinkSync(file.path);

            results.push({
                name: outputFileName,
                path: persistentPath,
                size: finalSize,
                pages: effectiveTotalPages, // nombre EXACT de pages converties
                thumbnail: thumbnail
            });
        }

        // Compute final statistics
        const totalSize = results.reduce((acc, r) => acc + r.size, 0);
        const totalPagesConverted = results.reduce((acc, r) => acc + (r.pages || 0), 0);

        // Cleanup temporary files (archives generated in TEMP_DIR)
        results.forEach(r => {
            const tempArchivePath = path.join(TEMP_DIR, r.name);
            if (fs.existsSync(tempArchivePath)) fs.unlinkSync(tempArchivePath);
        });

        res.json({
            success: true,
            message: `Conversion completed.`,
            stats: {
                totalFiles: results.length,
                totalPages: totalPagesConverted,
                totalSize: totalSize,
                outputDir: OUTPUT_DIR,
                files: results
            }
        });

    } catch (error) {
        console.error("Conversion error:", error);
        const errorMsg = error.message + (error.stderr ? `\nSTDERR: ${error.stderr}` : '');
        res.status(500).send('Conversion error: ' + errorMsg);
        // Attempt cleanup of remaining files
        if (req.files) req.files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
});

app.listen(port, () => {
    console.log(`BDConverter server started on http://localhost:${port}`);
});

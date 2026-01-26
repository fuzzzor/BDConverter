const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
let sharp;
try { sharp = require('sharp'); } catch(e) { console.warn('Sharp module not found.'); }

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

// Endpoint to receive client-side logs
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

// Route d'analyse préalable (comptage des pages pour les archives)
app.post('/analyze', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ pages: 0 });
    
    let filePath = req.file.path;
    
    // Rename with correct extension for 7z detection
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext && !filePath.toLowerCase().endsWith(ext)) {
        const newPath = filePath + ext;
        try { fs.renameSync(filePath, newPath); filePath = newPath; }
        catch(e) { console.error("Analyze rename error:", e); }
    }

    // Utilisation de 7z pour lister le contenu sans extraire
    // Note: On suppose que '7z' est dans le PATH système, comme pour la conversion
    exec(`7z l "${filePath}"`, (err, stdout, stderr) => {
        // Nettoyage du fichier temporaire immédiatement après l'analyse
        try { fs.unlinkSync(filePath); } catch(e) { console.error("Cleanup error:", e); }

        if (err) {
            console.warn("Analyzer error (7z):", err.message);
            // Fallback: 1 page par défaut si échec
            return res.json({ pages: 1 });
        }

        // Parsing de la sortie de 7z l
        // On cherche les lignes correspondant à des fichiers images
        const lines = stdout.split(/\r?\n/);
        let count = 0;
        for (const line of lines) {
            // Regex simplifiée pour détecter les extensions d'images dans la sortie 7z
            // 7z affiche : Date Time Attr Size Compressed Name
            if (/\.(jpg|jpeg|png|gif|webp|tiff|bmp)$/i.test(line) && !line.includes('__MACOSX') && !line.includes('thumbs.db')) {
                count++;
            }
        }
        
        res.json({ pages: count || 1 });
    });
});

// Route principale de conversion
app.post('/convert', upload.array('files'), async (req, res) => {
    const { dpi, colorMode, pageStart, pageEnd, format, compression, archiveCompression, imgFormat, requestId, rotation } = req.body;
    const isOriginal = dpi === 'original';
    const rotAngle = rotation ? parseInt(rotation) : 0;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    // Helper: is this a PDF?
    const isPdf = (filename) => filename.toLowerCase().endsWith('.pdf');
    
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

            // Base PDF filename (strip optional technical suffix _timestamp_uuid)
            let fileName = path.parse(file.originalname).name;
            fileName = fileName.replace(/_\d{13}_[a-f0-9\-]{36}$/i, '');
            const tempDir = path.join(__dirname, 'upload', fileName + "_temp_" + Date.now());
            fs.mkdirSync(tempDir, { recursive: true });

            const outputPrefix = path.join(tempDir, 'page');
            const fileIsPdf = isPdf(file.originalname);

            let effectiveTotalPages = 0;
            const safeImgFormat = (imgFormat || 'jpeg').toLowerCase();
            
            if (fileIsPdf) {
                // --- PDF PROCESSING ---
                // Ensure input file has .pdf extension
                if (!file.path.toLowerCase().endsWith('.pdf')) {
                    const newPath = file.path + '.pdf';
                    try { fs.renameSync(file.path, newPath); file.path = newPath; }
                    catch (err) { console.error("Error renaming input file:", err); }
                }

                // 1. Detect total pages
                const totalPages = await getPageCount(file.path);
                
                effectiveTotalPages = totalPages;
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
                
                if (isOriginal) {
                    tool = pdfimagesPath;
                    args = ['-all'];
                    if (pageStart) args.push('-f', pageStart);
                    if (pageEnd) args.push('-l', pageEnd);
                    args.push(file.path, outputPrefix);
                } else {
                    tool = popplerPath;
                    args = ['-r', dpiVal.toString()];
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
                    args.push(file.path, outputPrefix);
                }

                // Progress thumbnail (PDF only)
                if (FEATURE_PROGRESS_THUMBNAIL) {
                     try {
                        const colorPrefix = path.join(tempDir, 'thumb_color');
                        // Helper to make thumbnail
                        const makeThumb = (args, cb) => execFile(popplerPath, args, cb);

                        if (isOriginal) {
                            makeThumb(['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix], () => {
                                const f = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                                if (f) {
                                    const b64 = fs.readFileSync(path.join(tempDir, f)).toString('base64');
                                    sendProgress(requestId, { type: 'thumbnail-init', color: `data:image/jpeg;base64,${b64}` });
                                }
                            });
                        } else {
                            // Animated style
                            const grayPrefix = path.join(tempDir, 'thumb_gray');
                            makeThumb(['-jpeg', '-gray', '-scale-to', '200', '-f', '1', '-l', '1', file.path, grayPrefix], () => {
                                const g = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_gray') && f.endsWith('.jpg'));
                                if (g) {
                                    const gB64 = fs.readFileSync(path.join(tempDir, g)).toString('base64');
                                    makeThumb(['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix], () => {
                                        const c = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                                        if (c) {
                                            const cB64 = fs.readFileSync(path.join(tempDir, c)).toString('base64');
                                            sendProgress(requestId, { type: 'thumbnail-init', gray: `data:image/jpeg;base64,${gB64}`, color: `data:image/jpeg;base64,${cB64}` });
                                        }
                                    });
                                }
                            });
                        }
                    } catch(e) {}
                }

                // Execute PDF command
                sendProgress(requestId, { type: 'log', message: `Conversion in progress (${isOriginal ? 'Extraction' : 'Rendering'})...` });
                
                // Progress loop
                let progressInterval = null;
                if (totalPages) {
                    progressInterval = setInterval(() => {
                        try {
                            const filesInDir = fs.readdirSync(tempDir);
                            const pageImages = filesInDir.filter(f => /^page[-_]?(\d+).*(jpg|jpeg|png|tif|tiff|bmp)$/i.test(f));
                            const currentPages = pageImages.length;
                            const progress = effectiveTotalPages ? Math.min(100, Math.round((currentPages / effectiveTotalPages) * 100)) : 0;
                            sendProgress(requestId, { type: 'progress', currentFileIndex: index + 1, totalFiles: files.length, currentPct: progress, currentPages, totalPages: effectiveTotalPages });
                        } catch (e) {}
                    }, 1000);
                }

                await new Promise((resolve, reject) => {
                    execFile(tool, args, { timeout: 1800000, maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
                        if (progressInterval) clearInterval(progressInterval);
                        if (err) reject(err); else resolve();
                    });
                });

                // 2.5 Apply Rotation if requested (PDF mode)
                // Since pdftoppm doesn't support forced rotation output easily, we use sharp here.
                if (rotAngle !== 0 && sharp) {
                    const rawFiles = fs.readdirSync(tempDir).filter(f => !/^thumb_/i.test(f) && /\.(jpg|jpeg|png|tif|tiff|bmp)$/i.test(f));
                    console.log(`[INFO] Rotating ${rawFiles.length} files by ${rotAngle} degrees.`);
                    sendProgress(requestId, { type: 'log', message: `Applying rotation ${rotAngle}° to ${rawFiles.length} pages...` });
                    
                    // Process sequentially to avoid memory spikes
                    for (const f of rawFiles) {
                        const fPath = path.join(tempDir, f);
                        try {
                            const buffer = fs.readFileSync(fPath);
                            // Rotate and save back (buffer -> sharp -> buffer -> fs)
                            // Note: rotate(90) is 90 deg clockwise
                            await sharp(buffer).rotate(rotAngle).toFile(fPath);
                        } catch(e) {
                            console.error(`Error rotating ${f}:`, e);
                        }
                    }
                }

                // Prepare images for scan
                let imgFiles = fs.readdirSync(tempDir).filter(f => {
                    const validExts = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'];
                    return validExts.includes(path.extname(f).toLowerCase()) && !/^thumb_/i.test(f);
                });
                imgFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

                if (imgFiles.length === 0) throw new Error(`No images generated for ${file.originalname}`);

                // Rename logic for PDF output
                const padding = effectiveTotalPages.toString().length;
                imgFiles.slice(0, effectiveTotalPages).forEach((f, idx) => {
                    const num = (idx + 1).toString().padStart(Math.max(3, padding), '0');
                    const newName = `${num}${path.extname(f)}`;
                    fs.renameSync(path.join(tempDir, f), path.join(tempDir, newName));
                });

            } else {
                // --- ARCHIVE PROCESSING ---
                sendProgress(requestId, { type: 'log', message: `Extracting archive...` });
                
                // Rename archive with extension to help 7z detection
                const ext = path.extname(file.originalname).toLowerCase();
                if (ext && !file.path.toLowerCase().endsWith(ext)) {
                    const newPath = file.path + ext;
                    try { fs.renameSync(file.path, newPath); file.path = newPath; }
                    catch(e) { console.error("Archive rename error:", e); }
                }

                // 1. Extract (Use specific tools based on format for better compatibility)
                await new Promise((resolve, reject) => {
                    const ext = path.extname(file.originalname).toLowerCase();
                    
                    // Detect RAR signature (Magic Bytes) to handle .cbz files that are actually RARs
                    let isRarSignature = false;
                    try {
                        const fd = fs.openSync(file.path, 'r');
                        const buffer = Buffer.alloc(7);
                        fs.readSync(fd, buffer, 0, 7, 0);
                        fs.closeSync(fd);
                        if (buffer.toString('hex').startsWith('526172211a07')) isRarSignature = true;
                    } catch(e) {}

                    if (isRarSignature || ext === '.cbr' || ext === '.rar') {
                        if (isRarSignature && ext !== '.cbr' && ext !== '.rar') {
                            console.log(`[INFO] Detected RAR signature in ${ext} file. Switching to RAR extractor.`);
                        }
                        // Use 'rar' or 'unrar' for RAR files to support RAR5 (which old p7zip doesn't support)
                        // Dockerfile installs 'rar' (non-free). Syntax: rar x archive path/
                        exec(`rar x -y "${file.path}" "${tempDir}/"`, (err) => {
                            if (err) {
                                console.warn(`RAR extraction failed: ${err.message}. Trying unrar...`);
                                // Fallback to unrar
                                exec(`unrar x -y "${file.path}" "${tempDir}/"`, (err2) => {
                                    if (err2) {
                                        // Last resort: try 7z (might fail for RAR5)
                                        console.warn(`Unrar failed: ${err2.message}. Trying 7z...`);
                                        exec(`7z x "${file.path}" -o"${tempDir}"`, (err3) => {
                                            if (err3) reject(err); // Reject with original error
                                            else resolve();
                                        });
                                    }
                                    else resolve();
                                });
                            } else resolve();
                        });
                    } else {
                        // Use 7z for everything else (zip, cbz, 7z, tar...)
                        // "x" preserves paths.
                        exec(`7z x "${file.path}" -o"${tempDir}"`, (err) => {
                            if (err) reject(err); else resolve();
                        });
                    }
                });

                // 2. Scan recursively for images (handling encoding issues via Buffers)
                const getAllImages = (dirBuffer, list = []) => {
                    let entryNames;
                    try {
                        // Get just names as buffers (no withFileTypes to avoid implicit lstat issues)
                        entryNames = fs.readdirSync(dirBuffer, { encoding: 'buffer' });
                    } catch(e) { console.warn("Readdir failed:", e); return list; }

                    for (const nameBuffer of entryNames) {
                        // Manual path join for buffers
                        const separator = Buffer.from(path.sep);
                        const fullPathBuffer = Buffer.concat([dirBuffer, separator, nameBuffer]);

                        let stats;
                        try {
                            stats = fs.lstatSync(fullPathBuffer);
                        } catch(e) { continue; } // Skip inaccessible files

                        if (stats.isDirectory()) {
                            getAllImages(fullPathBuffer, list);
                        } else {
                            // Check extension safely
                            const nameStr = nameBuffer.toString('binary');
                            const ext = path.extname(nameStr).toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp', '.gif'].includes(ext)) {
                                list.push(fullPathBuffer);
                            }
                        }
                    }
                    return list;
                };

                let extractedImages = getAllImages(Buffer.from(tempDir));
                // Sort naturally (Buffers)
                extractedImages.sort((a, b) => a.compare(b));
                
                effectiveTotalPages = extractedImages.length;
                sendProgress(requestId, { type: 'log', message: `Images found in archive: ${effectiveTotalPages}` });

                if (effectiveTotalPages === 0) throw new Error("No images found in archive.");

                // Thumbnail for Archive
                if (FEATURE_PROGRESS_THUMBNAIL && extractedImages.length > 0) {
                    try {
                        const firstImgPath = extractedImages[0];
                        if (sharp) {
                            // Pass buffer content to sharp to avoid path encoding issues
                            const imgBuffer = fs.readFileSync(firstImgPath);
                            const buffer = await sharp(imgBuffer).resize(200).toBuffer();
                            const b64 = buffer.toString('base64');
                            sendProgress(requestId, { type: 'thumbnail-init', color: `data:image/jpeg;base64,${b64}` });
                        }
                    } catch(e) { console.warn("Thumb error:", e); }
                }

                // 3. Process Images (Flatten & Convert if needed)
                const processingDir = path.join(tempDir, 'processed');
                fs.mkdirSync(processingDir);

                const padding = effectiveTotalPages.toString().length;
                
                for (let i = 0; i < extractedImages.length; i++) {
                    const srcPath = extractedImages[i]; // Buffer
                    const num = (i + 1).toString().padStart(Math.max(3, padding), '0');
                    
                    // Determine extension safely
                    const srcPathStr = srcPath.toString('binary');
                    const ext = path.extname(srcPathStr).toLowerCase();

                    // Decide: Copy (Original) or Process (Sharp)
                    // If rotation is requested, we MUST use sharp even in "Original" mode (unless sharp is missing)
                    const needsProcessing = !isOriginal || (rotAngle !== 0);

                    if (!needsProcessing) {
                        // Just copy/move (srcPath is Buffer, works with fs)
                        fs.copyFileSync(srcPath, path.join(processingDir, `${num}${ext}`));
                    } else if (sharp) {
                        // Convert/Resize/Rotate
                        // Pass CONTENT buffer to sharp, not path buffer
                        let pipeline = sharp(fs.readFileSync(srcPath));

                        // Apply rotation
                        if (rotAngle !== 0) {
                            pipeline = pipeline.rotate(rotAngle);
                        }
                        
                        // DPI Resampling Logic (if not Original mode)
                        if (dpiVal) {
                            try {
                                const metadata = await pipeline.metadata();
                                const sourceDensity = metadata.density || 72; // Default density assumption
                                const targetDensity = dpiVal;
                                
                                // Resample if density differs significantly (> 2%)
                                // We assume constant physical size, so higher DPI = more pixels
                                if (Math.abs(targetDensity - sourceDensity) / sourceDensity > 0.02) {
                                    const newWidth = Math.round(metadata.width * (targetDensity / sourceDensity));
                                    pipeline = pipeline.resize(newWidth);
                                }
                                pipeline = pipeline.withMetadata({ density: targetDensity });
                            } catch (e) {
                                console.warn(`[WARN] Could not read metadata for resampling: ${srcPath}`, e);
                            }
                        }

                        // Color mode
                        if (colorMode === 'gray') pipeline = pipeline.grayscale();
                        // Note: mono (threshold) not simply supported by sharp without settings, skipping for now or mapped to gray

                        // Output format
                        let outExt = '.' + safeImgFormat;
                        if (safeImgFormat === 'jpeg') {
                            pipeline = pipeline.jpeg({ quality: compVal });
                            outExt = '.jpg';
                        } else if (safeImgFormat === 'png') {
                            pipeline = pipeline.png();
                        } else if (safeImgFormat === 'tiff') {
                            pipeline = pipeline.tiff();
                        }

                        await pipeline.toFile(path.join(processingDir, `${num}${outExt}`));
                    } else {
                        // Fallback if no sharp and no original: copy
                        fs.copyFileSync(srcPath, path.join(processingDir, `${num}${ext}`));
                    }

                    // Send progress manually since we are in a loop
                    if (i % 5 === 0) {
                        const pct = Math.round(((i + 1) / effectiveTotalPages) * 100);
                        sendProgress(requestId, {
                            type: 'progress',
                            currentFileIndex: index + 1,
                            totalFiles: files.length,
                            currentPct: pct,
                            currentPages: i + 1,
                            totalPages: effectiveTotalPages
                        });
                    }
                }

                // Clean old temp content and move processed to root of tempDir for archiving
                // Must handle buffers because of potential encoding issues in extracted folders
                const deleteFolderContents = (dirPathStr) => {
                    const dirBuffer = Buffer.from(dirPathStr);
                    let items;
                    try {
                        items = fs.readdirSync(dirBuffer, { encoding: 'buffer' });
                    } catch(e) { return; }

                    for (const itemBuffer of items) {
                        const itemStr = itemBuffer.toString('binary'); // Safe check for 'processed'
                        if (itemStr === 'processed' || itemStr.endsWith('processed')) continue;
                        
                        // Strict check: if item is exactly 'processed' in UTF8
                        if (itemBuffer.toString('utf8') === 'processed') continue;

                        const separator = Buffer.from(path.sep);
                        const curPathBuffer = Buffer.concat([dirBuffer, separator, itemBuffer]);
                        
                        try {
                            const stats = fs.lstatSync(curPathBuffer);
                            if (stats.isDirectory()) {
                                fs.rmSync(curPathBuffer, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(curPathBuffer);
                            }
                        } catch(e) {
                            // Try force remove if lstat fails
                            try { fs.rmSync(curPathBuffer, { recursive: true, force: true }); } catch(ex) {}
                        }
                    }
                };
                deleteFolderContents(tempDir);

                // Move processed files to tempDir
                const processedFiles = fs.readdirSync(processingDir);
                for (const f of processedFiles) {
                    fs.renameSync(path.join(processingDir, f), path.join(tempDir, f));
                }
                fs.rmdirSync(processingDir);
            }

            // Common Finalization
            sendProgress(requestId, {
                type: 'progress',
                currentFileIndex: index + 1,
                totalFiles: files.length,
                currentPct: 100,
                currentPages: effectiveTotalPages,
                totalPages: effectiveTotalPages,
                status: "Assembling..."
            });
            
            // Output name = original PDF name (without suffix)
            const outputFileName = `${fileName}.${format || 'cbz'}`;
            
            // Strict archive format validation
            const allowedFormats = ['cbz', 'cbt', 'cb7', 'cbr'];
            const safeFormat = allowedFormats.includes(format) ? format : 'cbz';
            
            // Generate SAFE temporary name for archive creation to avoid CLI encoding issues
            const safeTempArchiveName = `archive_${Date.now()}_${Math.random().toString(36).substring(7)}.${safeFormat}`;
            const tempOutputPath = path.join(TEMP_DIR, safeTempArchiveName);

            // Archive creation based on selected format
            if (safeFormat === 'cbt') {
                // TAR format (No compression by definition)
                await new Promise((resolve, reject) => {
                    exec(`tar -cf "${tempOutputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else if (safeFormat === 'cb7') {
                // 7Z format
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => {
                    exec(`7z a -t7z -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else if (safeFormat === 'cbr') {
                // RAR format (native)
                let rarComp = 3;
                if (isOriginal) {
                    rarComp = 0; // Store
                } else {
                    if (archCompVal === 0) rarComp = 0;
                    else if (archCompVal === 1) rarComp = 1;
                    else if (archCompVal === 3) rarComp = 2;
                    else if (archCompVal === 5) rarComp = 3;
                    else if (archCompVal === 7) rarComp = 4;
                    else if (archCompVal === 9) rarComp = 5;
                }

                await new Promise((resolve, reject) => {
                    exec(`rar a -r -m${rarComp} -ep1 "${tempOutputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                // CBZ format (default)
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => {
                    exec(`7z a -tzip -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            if (!fs.existsSync(tempOutputPath)) {
                throw new Error(`Archive generation failed: ${safeTempArchiveName} not found.`);
            }

            // Copy to persistent output directory
            const persistentPath = path.join(OUTPUT_DIR, outputFileName);
            fs.copyFileSync(tempOutputPath, persistentPath);
            
            // Cleanup temp archive
            fs.unlinkSync(tempOutputPath);

            const finalSize = fs.statSync(persistentPath).size;
            console.log(`[INFO] File saved to: ${persistentPath} (${finalSize} bytes)`);

            // ✅ Generate final thumbnail
            let thumbnail = null;
            try {
                if (fileIsPdf) {
                    // Use poppler for PDF source
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
                } else if (sharp) {
                    // Use sharp for Archive source (take first image from tempDir)
                    const images = fs.readdirSync(tempDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort();
                    if (images.length > 0) {
                        const buffer = await sharp(path.join(tempDir, images[0])).resize(200).toBuffer();
                        thumbnail = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                    }
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

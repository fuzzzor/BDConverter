const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const PDFDocument = require('pdfkit');
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
    const { dpi, maxWidth, colorMode, pageStart, pageEnd, format, compression, archiveCompression, imgFormat, requestId, rotation, splitDouble, readingDir } = req.body;
    const isOriginal = dpi === 'original';
    const rotAngle = rotation ? parseInt(rotation) : 0;
    const maxW = maxWidth ? parseInt(maxWidth) : null;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    // Restore full paths if provided by client (for folder drag & drop)
    try {
        if (req.body.filePaths) {
            const paths = JSON.parse(req.body.filePaths);
            if (Array.isArray(paths) && paths.length === files.length) {
                files.forEach((f, i) => {
                    if (paths[i]) f.originalname = paths[i];
                });
            }
        }
    } catch (e) {
        console.warn("Error parsing filePaths:", e);
    }

    // Helper: is this a PDF?
    const isPdf = (filename) => filename.toLowerCase().endsWith('.pdf');
    
    // Original mode: no rendering, pdfimages only
    const dpiVal = isOriginal ? null : (dpi ? parseInt(dpi) : 225);
    const compVal = compression ? parseInt(compression) : 80;
    const archCompVal = archiveCompression !== undefined ? parseInt(archiveCompression) : 5;

    try {
        sendProgress(requestId, { type: 'log', message: `Received ${files.length} file(s). Analyzing structure...` });

        // --- TASK DEFINITIONS (Helpers with closure access) ---

        // Helper: Process Merge Task (Images -> Archive)
        const processMergeTask = async (taskFiles, baseName, taskIdx, totalTasks) => {
            sendProgress(requestId, { type: 'log', message: `Starting task ${taskIdx+1}/${totalTasks}: Merging ${taskFiles.length} images into "${baseName}"` });
            
            const tempDir = path.join(TEMP_DIR, `merge_${Date.now()}_${Math.random().toString(36).substring(7)}`);
            fs.mkdirSync(tempDir, { recursive: true });

            const safeImgFormat = (imgFormat || 'jpeg').toLowerCase();
            const padding = taskFiles.length.toString().length;

            // Thumbnail Init (Merge Mode)
            if (FEATURE_PROGRESS_THUMBNAIL && sharp && taskFiles.length > 0) {
                try {
                    sendProgress(requestId, { type: 'log', message: `Generating preview for ${baseName}...` });
                    const buffer = await sharp(taskFiles[0].path).resize(200).toBuffer();
                    sendProgress(requestId, { type: 'thumbnail-init', color: `data:image/jpeg;base64,${buffer.toString('base64')}` });
                } catch(e) { console.warn("Merge Thumbnail error:", e); }
            }

            // Process Images
            for (const [idx, file] of taskFiles.entries()) {
                // Fix encoding
                file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
                
                const ext = path.extname(file.originalname).toLowerCase();
                const isExotic = ['.webp', '.bmp'].includes(ext);
                
                sendProgress(requestId, {
                    type: 'progress',
                    currentFileIndex: taskIdx + 1,
                    totalFiles: totalTasks,
                    totalPct: Math.round((idx / taskFiles.length) * 100),
                    currentFileName: baseName,
                    currentPages: idx + 1,
                    totalPages: taskFiles.length,
                    status: isExotic ? `Conversion jpg en cours... (${idx + 1}/${taskFiles.length})` : `Processing image ${idx + 1}/${taskFiles.length}`
                });

                const num = (idx + 1).toString().padStart(Math.max(3, padding), '0');
                
                // Force JPEG for exotic formats (WEBP, BMP)
                const forceJpeg = isExotic;
                
                const shouldUseSharp = sharp && (forceJpeg || rotAngle !== 0 || !isOriginal);

                if (shouldUseSharp) {
                    let pipeline = sharp(file.path);
                    if (rotAngle !== 0) pipeline = pipeline.rotate(rotAngle);
                    
                    // Resize logic (MaxWidth takes precedence over DPI-based resizing)
                    if (maxW && maxW > 0) {
                        try {
                            const metadata = await pipeline.metadata();
                            if (metadata.width > maxW) {
                                pipeline = pipeline.resize({ width: maxW, withoutEnlargement: true });
                            }
                            if (dpiVal) pipeline = pipeline.withMetadata({ density: dpiVal });
                        } catch (e) {}
                    } else if (dpiVal) {
                        try {
                            const metadata = await pipeline.metadata();
                            const sourceDensity = metadata.density || 72;
                            const targetDensity = dpiVal;
                            if (Math.abs(targetDensity - sourceDensity) / sourceDensity > 0.02) {
                                const newWidth = Math.round(metadata.width * (targetDensity / sourceDensity));
                                pipeline = pipeline.resize(newWidth);
                            }
                            pipeline = pipeline.withMetadata({ density: targetDensity });
                        } catch (e) {
                            pipeline = pipeline.withMetadata({ density: dpiVal });
                        }
                    }

                    if (colorMode === 'gray') pipeline = pipeline.grayscale();

                    let outExt = ext;
                    if (forceJpeg) {
                         pipeline = pipeline.jpeg({ quality: compVal });
                         outExt = '.jpg';
                    } else {
                        if (safeImgFormat === 'png') { pipeline = pipeline.png(); outExt = '.png'; }
                        else if (safeImgFormat === 'tiff') { pipeline = pipeline.tiff(); outExt = '.tiff'; }
                        else { pipeline = pipeline.jpeg({ quality: compVal }); outExt = '.jpg'; }
                    }
                    await pipeline.toFile(path.join(tempDir, `${num}${outExt}`));
                } else {
                    fs.copyFileSync(file.path, path.join(tempDir, `${num}${ext}`));
                }
            }

            // Create Archive
            sendProgress(requestId, {
                type: 'progress',
                currentPct: 100,
                status: "Assembling archive...",
                currentFileName: baseName
            });

            const allowedFormats = ['cbz', 'cbt', 'cb7', 'cbr', 'pdf', 'rar4', 'folder'];
            const safeFormat = allowedFormats.includes(format) ? format : 'cbz';
            
            let outputFileName = `${baseName}.${safeFormat}`;
            if (safeFormat === 'rar4') outputFileName = `${baseName}.cbr`;
            if (safeFormat === 'folder') outputFileName = baseName;

            const safeTempArchiveName = `archive_${Date.now()}_${Math.random().toString(36).substring(7)}.${safeFormat === 'rar4' ? 'cbr' : safeFormat}`;
            const tempOutputPath = path.join(TEMP_DIR, safeTempArchiveName);

            if (safeFormat === 'folder') {
                // Folder mode: skip archiving
            } else if (safeFormat === 'pdf') {
                await new Promise((resolve, reject) => {
                    const doc = new PDFDocument({ autoFirstPage: false });
                    const stream = fs.createWriteStream(tempOutputPath);
                    doc.pipe(stream);
                    const images = fs.readdirSync(tempDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
                    for (const imgFile of images) {
                        try {
                            const imgPath = path.join(tempDir, imgFile);
                            const img = doc.openImage(imgPath); 
                            doc.addPage({ margin: 0, size: [img.width, img.height] });
                            doc.image(imgPath, 0, 0, { width: img.width, height: img.height });
                        } catch(e) {}
                    }
                    doc.end();
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });
            } else if (safeFormat === 'cbt') {
                await new Promise((resolve, reject) => exec(`tar -cf "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'cb7') {
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => exec(`7z a -t7z -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'cbr') {
                 let rarComp = isOriginal ? 0 : (archCompVal === 0 ? 0 : 3);
                 await new Promise((resolve, reject) => exec(`rar a -r -m${rarComp} -ep1 "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'rar4') {
                 let rarComp = isOriginal ? 0 : (archCompVal === 0 ? 0 : 3);
                 await new Promise((resolve, reject) => exec(`rar a -ma4 -r -m${rarComp} -ep1 "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else {
                // CBZ
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => exec(`7z a -tzip -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            }

            // Finalize
            const persistentPath = path.join(OUTPUT_DIR, outputFileName);
            
            if (safeFormat === 'folder') {
                if (fs.existsSync(persistentPath)) fs.rmSync(persistentPath, { recursive: true, force: true });
                fs.mkdirSync(persistentPath, { recursive: true });
                
                // Copy only valid images, exclude thumbs
                const filesToCopy = fs.readdirSync(tempDir).filter(f =>
                    !f.startsWith('thumb_') &&
                    !f.startsWith('.') &&
                    /\.(jpg|jpeg|png|tif|tiff|bmp|webp)$/i.test(f)
                );
                
                for (const f of filesToCopy) {
                    fs.copyFileSync(path.join(tempDir, f), path.join(persistentPath, f));
                }
            } else {
                fs.copyFileSync(tempOutputPath, persistentPath);
                fs.unlinkSync(tempOutputPath);
            }

            // Thumbnail (from first image)
            let thumbnail = null;
            if (sharp) {
                try {
                    const images = fs.readdirSync(tempDir).filter(f => /\.(jpg|jpeg|png|webp|tiff|tif|bmp)$/i.test(f)).sort();
                    if (images.length > 0) {
                        const buffer = await sharp(path.join(tempDir, images[0])).resize(200).toBuffer();
                        thumbnail = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                    }
                } catch(e) { console.warn("Final Thumbnail generation error:", e); }
            }

            // Cleanup
            fs.rmSync(tempDir, { recursive: true, force: true });
            taskFiles.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });

            let finalSize = 0;
            if (safeFormat === 'folder') {
                 const getDirSize = (dir) => {
                    const files = fs.readdirSync(dir);
                    return files.reduce((acc, file) => {
                        const p = path.join(dir, file);
                        const s = fs.statSync(p);
                        return acc + (s.isDirectory() ? getDirSize(p) : s.size);
                    }, 0);
                 };
                 finalSize = getDirSize(persistentPath);
            } else {
                finalSize = fs.statSync(persistentPath).size;
            }
            
            return {
                name: outputFileName,
                path: persistentPath,
                size: finalSize,
                pages: taskFiles.length,
                thumbnail: thumbnail
            };
        };

        // Helper: Process Single File (PDF/Archive -> Archive)
        const processConvertTask = async (file, taskIdx, totalTasks) => {
            // Fix encoding
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

            sendProgress(requestId, {
                type: 'progress',
                currentFileIndex: taskIdx + 1,
                totalFiles: totalTasks,
                totalPct: 0,
                currentFileName: file.originalname,
                currentPct: 0,
                status: `Analyzing ${file.originalname}...`
            });

            let fileName = path.parse(file.originalname).name;
            fileName = fileName.replace(/_\d{13}_[a-f0-9\-]{36}$/i, '');
            const tempDir = path.join(__dirname, 'upload', fileName + "_temp_" + Date.now());
            fs.mkdirSync(tempDir, { recursive: true });

            const outputPrefix = path.join(tempDir, 'page');
            const fileIsPdf = isPdf(file.originalname);

            let effectiveTotalPages = 0;
            const safeImgFormat = (imgFormat || 'jpeg').toLowerCase();
            
            if (fileIsPdf) {
                if (!file.path.toLowerCase().endsWith('.pdf')) {
                    const newPath = file.path + '.pdf';
                    try { fs.renameSync(file.path, newPath); file.path = newPath; }
                    catch (err) { console.error("Error renaming input file:", err); }
                }

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
                    if (maxW && maxW > 0) {
                        // Use scale-to-x for PDF resizing (keeps aspect ratio)
                        args.push('-scale-to-x', maxW.toString(), '-scale-to-y', '-1');
                    }
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
                        sendProgress(requestId, { type: 'log', message: `Generating preview...` });
                        const colorPrefix = path.join(tempDir, 'thumb_color');
                        const makeThumb = (args) => new Promise(resolve => execFile(popplerPath, args, (err) => resolve(err ? null : true)));

                        if (isOriginal) {
                            await makeThumb(['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix]);
                            try {
                                const f = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                                if (f) {
                                    const b64 = fs.readFileSync(path.join(tempDir, f)).toString('base64');
                                    sendProgress(requestId, { type: 'thumbnail-init', color: `data:image/jpeg;base64,${b64}` });
                                }
                            } catch(e) {}
                        } else {
                            const grayPrefix = path.join(tempDir, 'thumb_gray');
                            await makeThumb(['-jpeg', '-gray', '-scale-to', '200', '-f', '1', '-l', '1', file.path, grayPrefix]);
                            let gB64 = null;
                            try {
                                const g = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_gray') && f.endsWith('.jpg'));
                                if (g) gB64 = fs.readFileSync(path.join(tempDir, g)).toString('base64');
                            } catch(e) {}

                            if (gB64) {
                                await makeThumb(['-jpeg', '-scale-to', '200', '-f', '1', '-l', '1', file.path, colorPrefix]);
                                try {
                                    const c = fs.readdirSync(tempDir).find(f => f.startsWith('thumb_color') && f.endsWith('.jpg'));
                                    if (c) {
                                        const cB64 = fs.readFileSync(path.join(tempDir, c)).toString('base64');
                                        sendProgress(requestId, { type: 'thumbnail-init', gray: `data:image/jpeg;base64,${gB64}`, color: `data:image/jpeg;base64,${cB64}` });
                                    }
                                } catch(e) {}
                            }
                        }
                    } catch(e) {}
                }

                sendProgress(requestId, { type: 'log', message: `Conversion in progress (${isOriginal ? 'Extraction' : 'Rendering'})...` });
                
                let progressInterval = null;
                if (totalPages) {
                    progressInterval = setInterval(() => {
                        try {
                            const filesInDir = fs.readdirSync(tempDir);
                            const pageImages = filesInDir.filter(f => /^page[-_]?(\d+).*(jpg|jpeg|png|tif|tiff|bmp)$/i.test(f));
                            const currentPages = pageImages.length;
                            const progress = effectiveTotalPages ? Math.min(100, Math.round((currentPages / effectiveTotalPages) * 100)) : 0;
                            sendProgress(requestId, { type: 'progress', currentFileIndex: taskIdx + 1, totalFiles: totalTasks, currentPct: progress, currentPages, totalPages: effectiveTotalPages });
                        } catch (e) {}
                    }, 1000);
                }

                await new Promise((resolve, reject) => {
                    execFile(tool, args, { timeout: 1800000, maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
                        if (progressInterval) clearInterval(progressInterval);
                        if (err) reject(err); else resolve();
                    });
                });

                if (rotAngle !== 0 && sharp) {
                    const rawFiles = fs.readdirSync(tempDir).filter(f => !/^thumb_/i.test(f) && /\.(jpg|jpeg|png|tif|tiff|bmp)$/i.test(f));
                    sendProgress(requestId, { type: 'log', message: `Applying rotation ${rotAngle}° to ${rawFiles.length} pages...` });
                    for (const f of rawFiles) {
                        const fPath = path.join(tempDir, f);
                        try {
                            const buffer = fs.readFileSync(fPath);
                            if (buffer.length > 0) await sharp(buffer).rotate(rotAngle).toFile(fPath);
                        } catch(e) {}
                    }
                }

                let imgFiles = fs.readdirSync(tempDir).filter(f => {
                    const validExts = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'];
                    return validExts.includes(path.extname(f).toLowerCase()) && !/^thumb_/i.test(f);
                });
                imgFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

                if (imgFiles.length === 0) throw new Error(`No images generated for ${file.originalname}`);

                // Handle optional splitting of landscape (double) pages
                // If splitDouble==='auto', use Sharp to split wide images into two vertical halves
                // IMPORTANT: Disable splitting if "Original" mode (dpi='original') is active
                let expandedFiles = [];
                if (splitDouble === 'auto' && sharp && !isOriginal) {
                    for (let i = 0; i < Math.min(imgFiles.length, effectiveTotalPages); i++) {
                        const f = imgFiles[i];
                        const fullPath = path.join(tempDir, f);
                        try {
                            const meta = await sharp(fullPath).metadata();
                            if (meta && meta.width && meta.height && (meta.width / meta.height) > 1.2) {
                                // Split vertically into two halves
                                const halfW = Math.floor(meta.width / 2);
                                const leftBuf = await sharp(fullPath).extract({ left: 0, top: 0, width: halfW, height: meta.height }).toBuffer();
                                const rightBuf = await sharp(fullPath).extract({ left: meta.width - halfW, top: 0, width: halfW, height: meta.height }).toBuffer();
                                // Use jpg for output halves
                                const outExt = '.jpg';
                                const leftName = `split_${i+1}_a${outExt}`;
                                const rightName = `split_${i+1}_b${outExt}`;
                                fs.writeFileSync(path.join(tempDir, leftName), leftBuf);
                                fs.writeFileSync(path.join(tempDir, rightName), rightBuf);
                                // Order halves according to readingDir
                                if ((readingDir || 'ltr') === 'ltr') {
                                    expandedFiles.push(leftName, rightName);
                                } else {
                                    expandedFiles.push(rightName, leftName);
                                }
                                // Remove original wide file to avoid duplication
                                try { fs.unlinkSync(fullPath); } catch(e) {}
                                continue;
                            }
                        } catch (e) {
                            // On error, fall back to using the original file
                        }
                        expandedFiles.push(f);
                    }
                } else {
                    // No splitting requested or Sharp unavailable: keep original page list
                    expandedFiles = imgFiles.slice(0, effectiveTotalPages);
                }

                // If splitting increased page count, update effectiveTotalPages
                const finalPageFiles = expandedFiles;
                const finalPageCount = finalPageFiles.length;
                const padding = finalPageCount.toString().length;

                // Rename (re-number) final pages sequentially
                finalPageFiles.forEach((f, idx) => {
                    const num = (idx + 1).toString().padStart(Math.max(3, padding), '0');
                    const newName = `${num}${path.extname(f)}`;
                    const src = path.join(tempDir, f);
                    const dst = path.join(tempDir, newName);
                    try { fs.renameSync(src, dst); } catch(e) {}
                });

            } else {
                // --- ARCHIVE PROCESSING ---
                sendProgress(requestId, { type: 'log', message: `Extracting archive...` });
                
                const ext = path.extname(file.originalname).toLowerCase();
                if (ext && !file.path.toLowerCase().endsWith(ext)) {
                    const newPath = file.path + ext;
                    try { fs.renameSync(file.path, newPath); file.path = newPath; }
                    catch(e) { console.error("Archive rename error:", e); }
                }

                // Fast Thumbnail
                if (FEATURE_PROGRESS_THUMBNAIL && sharp) {
                    sendProgress(requestId, { type: 'log', message: `Generating preview...` });
                    try {
                        await new Promise(resolve => {
                            exec(`7z l -slt "${file.path}"`, async (err, stdout) => {
                                if (err) { resolve(); return; }
                                const match = stdout.match(/Path = (.+\.(jpg|jpeg|png|webp))[\r\n]/i);
                                if (match && match[1]) {
                                    const imgPath = match[1].trim();
                                    const thumbTempDir = path.join(tempDir, 'thumb_fast');
                                    fs.mkdirSync(thumbTempDir, { recursive: true });
                                    exec(`7z e "${file.path}" -o"${thumbTempDir}" "${imgPath}" -y`, async (err2) => {
                                        if (!err2) {
                                            try {
                                                const files = fs.readdirSync(thumbTempDir);
                                                const imgFile = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
                                                if (imgFile) {
                                                    const b = await sharp(path.join(thumbTempDir, imgFile)).resize(200).toBuffer();
                                                    const b64 = b.toString('base64');
                                                    sendProgress(requestId, { type: 'thumbnail-init', color: `data:image/jpeg;base64,${b64}` });
                                                }
                                            } catch(e) {}
                                            try { fs.rmSync(thumbTempDir, { recursive: true, force: true }); } catch(e){}
                                        }
                                        resolve();
                                    });
                                } else { resolve(); }
                            });
                        });
                    } catch(e) {}
                }

                await new Promise((resolve, reject) => {
                    const ext = path.extname(file.originalname).toLowerCase();
                    let isRarSignature = false;
                    try {
                        const fd = fs.openSync(file.path, 'r');
                        const buffer = Buffer.alloc(7);
                        fs.readSync(fd, buffer, 0, 7, 0);
                        fs.closeSync(fd);
                        if (buffer.toString('hex').startsWith('526172211a07')) isRarSignature = true;
                    } catch(e) {}

                    if (isRarSignature || ext === '.cbr' || ext === '.rar') {
                        exec(`rar x -y "${file.path}" "${tempDir}/"`, (err) => {
                            if (err) {
                                exec(`unrar x -y "${file.path}" "${tempDir}/"`, (err2) => {
                                    if (err2) {
                                        exec(`7z x "${file.path}" -o"${tempDir}"`, (err3) => {
                                            if (err3) reject(err); else resolve();
                                        });
                                    } else resolve();
                                });
                            } else resolve();
                        });
                    } else {
                        exec(`7z x "${file.path}" -o"${tempDir}"`, (err) => {
                            if (err) reject(err); else resolve();
                        });
                    }
                });

                const getAllImages = (dirBuffer, list = []) => {
                    let entryNames;
                    try { entryNames = fs.readdirSync(dirBuffer, { encoding: 'buffer' }); } catch(e) { return list; }
                    for (const nameBuffer of entryNames) {
                        const separator = Buffer.from(path.sep);
                        const fullPathBuffer = Buffer.concat([dirBuffer, separator, nameBuffer]);
                        let stats;
                        try { stats = fs.lstatSync(fullPathBuffer); } catch(e) { continue; }
                        if (stats.isDirectory()) {
                            getAllImages(fullPathBuffer, list);
                        } else {
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
                extractedImages.sort((a, b) => a.compare(b));
                
                const totalExtracted = extractedImages.length;
                const pStart = pageStart ? parseInt(pageStart) : 1;
                const pEnd = pageEnd ? parseInt(pageEnd) : totalExtracted;
                const effStart = Math.max(1, pStart);
                const effEnd = Math.min(totalExtracted, pEnd);
                
                effectiveTotalPages = Math.max(0, effEnd - effStart + 1);
                sendProgress(requestId, { type: 'log', message: `Images found: ${totalExtracted}. Converting range ${effStart}-${effEnd} (${effectiveTotalPages} pages).` });

                if (effectiveTotalPages === 0) throw new Error("No images in range.");

                // Thumbnail logic for Archive if not already done... (omitted for brevity, handled by fast thumb)

                const processingDir = path.join(tempDir, 'processed');
                fs.mkdirSync(processingDir);

                const padding = effectiveTotalPages.toString().length;
                let processedCount = 0;
                
                for (let i = 0; i < extractedImages.length; i++) {
                    const currentNum = i + 1;
                    if (currentNum < effStart || currentNum > effEnd) continue;

                    const srcPath = extractedImages[i];
                    const num = (processedCount + 1).toString().padStart(Math.max(3, padding), '0');
                    processedCount++;
                    
                    const srcPathStr = srcPath.toString('binary');
                    const ext = path.extname(srcPathStr).toLowerCase();
                    const needsProcessing = !isOriginal || (rotAngle !== 0);

                    if (!needsProcessing) {
                        fs.copyFileSync(srcPath, path.join(processingDir, `${num}${ext}`));
                    } else if (sharp) {
                        const inputBuffer = fs.readFileSync(srcPath);
                        if (inputBuffer.length === 0) continue;

                        let pipeline = sharp(inputBuffer);
                        if (rotAngle !== 0) pipeline = pipeline.rotate(rotAngle);
                        
                        if (maxW && maxW > 0) {
                            try {
                                const metadata = await pipeline.metadata();
                                if (metadata.width > maxW) {
                                    pipeline = pipeline.resize({ width: maxW, withoutEnlargement: true });
                                }
                                if (dpiVal) pipeline = pipeline.withMetadata({ density: dpiVal });
                            } catch (e) {}
                        } else if (dpiVal) {
                            try {
                                const metadata = await pipeline.metadata();
                                const sourceDensity = metadata.density || 72;
                                const targetDensity = dpiVal;
                                if (Math.abs(targetDensity - sourceDensity) / sourceDensity > 0.02) {
                                    const newWidth = Math.round(metadata.width * (targetDensity / sourceDensity));
                                    pipeline = pipeline.resize(newWidth);
                                }
                                pipeline = pipeline.withMetadata({ density: targetDensity });
                            } catch (e) {}
                        }

                        if (colorMode === 'gray') pipeline = pipeline.grayscale();

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
                        fs.copyFileSync(srcPath, path.join(processingDir, `${num}${ext}`));
                    }

                    if (processedCount % 5 === 0) {
                        const pct = Math.round((processedCount / effectiveTotalPages) * 100);
                        sendProgress(requestId, {
                            type: 'progress',
                            currentFileIndex: taskIdx + 1,
                            totalFiles: totalTasks,
                            currentPct: pct,
                            currentPages: processedCount,
                            totalPages: effectiveTotalPages
                        });
                    }
                }

                // Cleanup folders in tempDir
                const deleteFolderContents = (dirPathStr) => {
                    const dirBuffer = Buffer.from(dirPathStr);
                    let items;
                    try { items = fs.readdirSync(dirBuffer, { encoding: 'buffer' }); } catch(e) { return; }
                    for (const itemBuffer of items) {
                        const itemStr = itemBuffer.toString('binary');
                        if (itemStr === 'processed' || itemStr.endsWith('processed')) continue;
                        if (itemBuffer.toString('utf8') === 'processed') continue;
                        const separator = Buffer.from(path.sep);
                        const curPathBuffer = Buffer.concat([dirBuffer, separator, itemBuffer]);
                        try {
                            const stats = fs.lstatSync(curPathBuffer);
                            if (stats.isDirectory()) fs.rmSync(curPathBuffer, { recursive: true, force: true });
                            else fs.unlinkSync(curPathBuffer);
                        } catch(e) {}
                    }
                };
                deleteFolderContents(tempDir);

                const processedFiles = fs.readdirSync(processingDir);
                for (const f of processedFiles) {
                    fs.renameSync(path.join(processingDir, f), path.join(tempDir, f));
                }
                fs.rmdirSync(processingDir);
            }

            // Finalize (Same logic as Merge)
            sendProgress(requestId, {
                type: 'progress',
                currentFileIndex: taskIdx + 1,
                totalFiles: totalTasks,
                currentPct: 100,
                currentPages: effectiveTotalPages,
                totalPages: effectiveTotalPages,
                status: "Assembling..."
            });
            
            const allowedFormats = ['cbz', 'cbt', 'cb7', 'cbr', 'pdf', 'rar4', 'folder'];
            const safeFormat = allowedFormats.includes(format) ? format : 'cbz';
            
            let outputFileName = `${fileName}.${safeFormat}`;
            if (safeFormat === 'rar4') outputFileName = `${fileName}.cbr`;
            if (safeFormat === 'folder') outputFileName = fileName;
            
            const safeTempArchiveName = `archive_${Date.now()}_${Math.random().toString(36).substring(7)}.${safeFormat === 'rar4' ? 'cbr' : safeFormat}`;
            const tempOutputPath = path.join(TEMP_DIR, safeTempArchiveName);

            if (safeFormat === 'folder') {
            } else if (safeFormat === 'pdf') {
                await new Promise((resolve, reject) => {
                    const doc = new PDFDocument({ autoFirstPage: false });
                    const stream = fs.createWriteStream(tempOutputPath);
                    doc.pipe(stream);
                    const images = fs.readdirSync(tempDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
                    for (const imgFile of images) {
                        try {
                            const imgPath = path.join(tempDir, imgFile);
                            const { width, height } = { width: 595, height: 842 }; // Simplified logic vs Merge
                            try {
                                const img = doc.openImage(imgPath);
                                doc.addPage({ margin: 0, size: [img.width, img.height] });
                                doc.image(imgPath, 0, 0, { width: img.width, height: img.height });
                            } catch(e) {}
                        } catch(e) {}
                    }
                    doc.end();
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });
            } else if (safeFormat === 'cbt') {
                await new Promise((resolve, reject) => exec(`tar -cf "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'cb7') {
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => exec(`7z a -t7z -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'cbr') {
                let rarComp = 3;
                if (isOriginal) rarComp = 0;
                else {
                    if (archCompVal === 0) rarComp = 0;
                    else if (archCompVal === 1) rarComp = 1;
                    else if (archCompVal === 3) rarComp = 2;
                    else if (archCompVal === 5) rarComp = 3;
                    else if (archCompVal === 7) rarComp = 4;
                    else if (archCompVal === 9) rarComp = 5;
                }
                await new Promise((resolve, reject) => exec(`rar a -r -m${rarComp} -ep1 "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else if (safeFormat === 'rar4') {
                let rarComp = 3;
                if (isOriginal) rarComp = 0;
                else {
                    if (archCompVal === 0) rarComp = 0;
                    else if (archCompVal === 1) rarComp = 1;
                    else if (archCompVal === 3) rarComp = 2;
                    else if (archCompVal === 5) rarComp = 3;
                    else if (archCompVal === 7) rarComp = 4;
                    else if (archCompVal === 9) rarComp = 5;
                }
                await new Promise((resolve, reject) => exec(`rar a -ma4 -r -m${rarComp} -ep1 "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            } else {
                const level = isOriginal ? 0 : archCompVal;
                await new Promise((resolve, reject) => exec(`7z a -tzip -mx=${level} "${tempOutputPath}" .`, { cwd: tempDir }, (err) => err ? reject(err) : resolve()));
            }

            if (safeFormat !== 'folder' && !fs.existsSync(tempOutputPath)) {
                throw new Error(`Archive generation failed: ${safeTempArchiveName} not found.`);
            }

            const persistentPath = path.join(OUTPUT_DIR, outputFileName);
            
            let finalSize = 0;
            if (safeFormat === 'folder') {
                if (fs.existsSync(persistentPath)) fs.rmSync(persistentPath, { recursive: true, force: true });
                fs.mkdirSync(persistentPath, { recursive: true });
                
                // Copy only valid images, exclude thumbs
                const filesToCopy = fs.readdirSync(tempDir).filter(f =>
                    !f.startsWith('thumb_') &&
                    !f.startsWith('.') &&
                    /\.(jpg|jpeg|png|tif|tiff|bmp|webp)$/i.test(f)
                );
                
                for (const f of filesToCopy) {
                    fs.copyFileSync(path.join(tempDir, f), path.join(persistentPath, f));
                }
                
                const getDirSize = (dir) => {
                    const files = fs.readdirSync(dir);
                    return files.reduce((acc, file) => {
                        const p = path.join(dir, file);
                        const s = fs.statSync(p);
                        return acc + (s.isDirectory() ? getDirSize(p) : s.size);
                    }, 0);
                 };
                 finalSize = getDirSize(persistentPath);
            } else {
                fs.copyFileSync(tempOutputPath, persistentPath);
                fs.unlinkSync(tempOutputPath);
                finalSize = fs.statSync(persistentPath).size;
            }

            // Generate final thumbnail
            let thumbnail = null;
            if (sharp) {
                try {
                    const images = fs.readdirSync(tempDir).filter(f => /\.(jpg|jpeg|png|webp|tiff|tif|bmp)$/i.test(f)).sort();
                    if (images.length > 0) {
                        const buffer = await sharp(path.join(tempDir, images[0])).resize(200).toBuffer();
                        thumbnail = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                    }
                } catch(e) { console.warn("Final Thumbnail generation error:", e); }
            }
            
            fs.rmSync(tempDir, { recursive: true, force: true });
            fs.unlinkSync(file.path);

            return {
                name: outputFileName,
                path: persistentPath,
                size: finalSize,
                pages: effectiveTotalPages,
                thumbnail: thumbnail
            };
        };

        // --- GROUPING LOGIC ---
        const tasks = [];
        const groups = {};
        const rootFiles = [];
        const isImageFile = (f) => /\.(jpg|jpeg|png|tif|tiff|bmp|webp)$/i.test(f.originalname);

        for (const file of files) {
            // Normalize path separators (Multer/FormData behavior)
            const name = file.originalname.replace(/\\/g, '/');
            const parts = name.split('/');
            
            if (parts.length > 1) {
                // Inside a folder
                const rootDir = parts[0];
                if (!groups[rootDir]) groups[rootDir] = [];
                groups[rootDir].push(file);
            } else {
                rootFiles.push(file);
            }
        }

        // Root Images (Merge "Converted_Images")
        const rootImages = rootFiles.filter(isImageFile);
        if (rootImages.length > 0) {
            let name = "Converted_Images";
            // If only one image, use its name? No, merge behavior usually implies collection.
            // But if user drags 1 image to convert to PDF?
            if (rootImages.length === 1) name = path.parse(rootImages[0].originalname).name;
            else name = path.parse(rootImages[0].originalname).name + "_set"; // Use first file name as base
            
            tasks.push({ type: 'MERGE', files: rootImages, name: name });
        }

        // Folder Groups
        for (const [dirName, dirFiles] of Object.entries(groups)) {
            const images = dirFiles.filter(isImageFile);
            if (images.length > 0) {
                tasks.push({ type: 'MERGE', files: images, name: dirName });
            }
        }

        // Root Documents (Convert)
        const rootDocs = rootFiles.filter(f => !isImageFile(f));
        for (const doc of rootDocs) {
            tasks.push({ type: 'CONVERT', file: doc });
        }

        sendProgress(requestId, { type: 'log', message: `Identified ${tasks.length} task(s).` });

        const results = [];
        
        // --- PROCESS TASKS ---
        for (const [idx, task] of tasks.entries()) {
             if (task.type === 'MERGE') {
                 const res = await processMergeTask(task.files, task.name, idx, tasks.length);
                 if (res) results.push(res);
             } else {
                 const res = await processConvertTask(task.file, idx, tasks.length);
                 if (res) results.push(res);
             }
        }

        // Compute final statistics
        const totalSize = results.reduce((acc, r) => acc + r.size, 0);
        const totalPagesConverted = results.reduce((acc, r) => acc + (r.pages || 0), 0);

        // Cleanup temporary files (archives generated in TEMP_DIR) -> Handled by helpers
        
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

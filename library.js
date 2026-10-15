// Library destination (optional feature, enabled with LIBRARY_DIR)
// ------------------------------------------------------------------
// Lets the user choose, from the web UI, where converted files are placed:
//   - next to the original file (found in the library by name, and size when ambiguous)
//   - or any folder of the library (folder browser in the UI)
// Converted files are never overwritten: "Name.cbz" becomes "Name (2).cbz" if needed.
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');

const ORIGIN = ':origin';
const SOURCE_EXT = ['.pdf', '.cbz', '.cbr', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.tar', '.epub'];
const INDEX_TTL_MS = 2 * 60 * 1000;
const FOLDER_SOURCE_EXT = ['.pdf', '.cbr', '.cbz', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.tar'];

module.exports = function createLibrary({ logInfo = console.log, logWarn = console.warn } = {}) {
    const LIBRARY_DIR = process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : null;
    const enabled = !!(LIBRARY_DIR && fs.existsSync(LIBRARY_DIR));
    if (process.env.LIBRARY_DIR && !enabled) logWarn(`[LIBRARY] LIBRARY_DIR not found: ${LIBRARY_DIR}`);
    if (enabled) logInfo(`[LIBRARY] Destination feature enabled, library: ${LIBRARY_DIR}`);

    // Resolve a path relative to LIBRARY_DIR, refusing anything outside of it
    const resolveSafe = (rel) => {
        const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const abs = path.resolve(LIBRARY_DIR, clean);
        if (abs !== LIBRARY_DIR && !abs.startsWith(LIBRARY_DIR + path.sep)) throw new Error('Path outside of the library');
        return abs;
    };
    const toRel = (abs) => path.relative(LIBRARY_DIR, abs).split(path.sep).join('/');

    // Never overwrite an existing file
    const uniqueTarget = (dir, name) => {
        let target = path.join(dir, name);
        if (!fs.existsSync(target)) return target;
        const ext = path.extname(name);
        const base = ext ? name.slice(0, -ext.length) : name;
        for (let i = 2; i < 1000; i++) {
            target = path.join(dir, `${base} (${i})${ext}`);
            if (!fs.existsSync(target)) return target;
        }
        throw new Error(`Too many duplicates for ${name}`);
    };

    // The container usually runs as root: give new files the owner of the destination folder
    const chownLike = (target, dir) => {
        try {
            const st = fs.statSync(dir);
            const walk = (p) => {
                fs.chownSync(p, st.uid, st.gid);
                if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach(f => walk(path.join(p, f)));
            };
            walk(target);
        } catch (e) { /* not supported (Windows) or not permitted: keep default owner */ }
    };

    const moveTo = (src, target) => {
        try {
            fs.renameSync(src, target);
        } catch (e) {
            if (e.code !== 'EXDEV') throw e; // different file systems: copy then delete
            fs.cpSync(src, target, { recursive: true, errorOnExist: true, force: false });
            fs.rmSync(src, { recursive: true, force: true });
        }
    };

    // Index of the library: lower-case file name -> [{ dir, path }]
    let index = null;
    let indexTime = 0;
    const getIndex = (force) => {
        if (!force && index && Date.now() - indexTime < INDEX_TTL_MS) return index;
        const t0 = Date.now();
        const idx = new Map();
        const stack = [LIBRARY_DIR];
        let count = 0;
        while (stack.length) {
            const d = stack.pop();
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name.startsWith('@') || e.name === '#recycle') continue;
                const p = path.join(d, e.name);
                if (e.isDirectory()) stack.push(p);
                else if (e.isFile() && SOURCE_EXT.includes(path.extname(e.name).toLowerCase())) {
                    const key = e.name.toLowerCase();
                    if (!idx.has(key)) idx.set(key, []);
                    idx.get(key).push({ dir: d, path: p });
                    count++;
                }
            }
        }
        index = idx;
        indexTime = Date.now();
        logInfo(`[LIBRARY] Indexed ${count} files in ${Date.now() - t0} ms`);
        return idx;
    };

    // Folder of the original file: same name, and same size when there are several candidates
    const findOriginalDir = (name, size) => {
        const key = path.basename(String(name || '').replace(/\\/g, '/')).toLowerCase();
        if (!key) return null;
        let cands = getIndex().get(key) || [];
        if (!cands.length && Date.now() - indexTime > 10000) cands = getIndex(true).get(key) || [];
        if (!cands.length) return null;
        const sameSize = cands.filter(c => { try { return fs.statSync(c.path).size === Number(size); } catch (e) { return false; } });
        if (sameSize.length) return sameSize[0].dir;
        return cands.length === 1 ? cands[0].dir : null;
    };

    // --- Convert whole library folders directly on the server ---
    // Files are read from the server's disk and sent to BDConverter's own /convert on 127.0.0.1:
    // nothing goes through the browser, and the conversion goes on if the page is closed.
    const PORT = Number(process.env.PORT || 3111);
    const FOLDER_CONCURRENCY = Math.max(1, Number(process.env.FOLDER_CONCURRENCY || 2));
    let folderJob = null;

    const outputExt = (format) => (format === 'rar4' ? '.cbr' : '.' + (format || 'cbz'));

    // Files to convert in the given folders (optionally their sub-folders); files that already
    // have their converted version next to them are skipped
    const scanFolders = (roots, recursive, types, format) => {
        const ext = outputExt(format);
        const todo = [];
        const seen = new Set();
        let already = 0;
        const walk = (d) => {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name.startsWith('@') || e.name === '#recycle') continue;
                const p = path.join(d, e.name);
                if (e.isDirectory()) { if (recursive) walk(p); continue; }
                const x = path.extname(e.name).toLowerCase();
                if (!e.isFile() || !types.includes(x) || x === ext || seen.has(p)) continue;
                seen.add(p);
                if (fs.existsSync(path.join(d, e.name.slice(0, -x.length) + ext))) { already++; continue; }
                todo.push(p);
            }
        };
        roots.forEach(walk);
        return { todo, already };
    };

    // Send one library file to /convert (multipart written by hand: no dependency, no time limit)
    const convertOne = (file, options) => new Promise((resolve, reject) => {
        const name = path.basename(file);
        const boundary = '----bdcfolder' + Date.now() + Math.random().toString(36).slice(2);
        const fields = Object.assign({}, options, {
            filePaths: JSON.stringify([name]),
            destDir: toRel(path.dirname(file)),
            requestId: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        });
        let headStr = '';
        Object.keys(fields).forEach(k => {
            headStr += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`;
        });
        headStr += `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name.replace(/"/g, '_')}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n';
        const head = Buffer.from(headStr, 'utf8');
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const size = fs.statSync(file).size;
        const req = http.request({
            host: '127.0.0.1', port: PORT, method: 'POST', path: '/convert',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + size + tail.length }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(data.slice(0, 200) || `HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid response')); }
            });
        });
        req.on('error', reject);
        req.write(head);
        const rs = fs.createReadStream(file);
        rs.on('error', (e) => { req.destroy(e); reject(e); });
        rs.on('end', () => req.end(tail));
        rs.pipe(req, { end: false });
    });

    const runFolderJob = async (job) => {
        let next = 0;
        const worker = async () => {
            while (!job.cancelled && next < job.files.length) {
                const file = job.files[next++];
                const rel = toRel(file);
                job.current.push(rel);
                try {
                    const res = await convertOne(file, job.options);
                    if (!(res.stats && res.stats.totalFiles)) throw new Error('no file produced');
                    job.done++;
                } catch (e) {
                    job.errors.push(`${rel}: ${e.message}`);
                    logWarn(`[LIBRARY] Folder conversion error, ${rel}: ${e.message}`);
                }
                job.current = job.current.filter(c => c !== rel);
            }
        };
        await Promise.all(Array.from({ length: Math.min(FOLDER_CONCURRENCY, job.files.length) }, worker));
        job.state = job.cancelled ? 'cancelled' : 'done';
        job.finishedAt = Date.now();
        logInfo(`[LIBRARY] Folder conversion ${job.label || job.folderCount + ' folders'} finished: ${job.done} converted, ${job.errors.length} error(s)`);
    };

    const jobView = (job) => job ? {
        state: job.state, label: job.label, folderCount: job.folderCount, total: job.files.length, done: job.done, skipped: job.skipped,
        errors: job.errors.slice(-20), errorCount: job.errors.length, current: job.current,
        startedAt: job.startedAt, finishedAt: job.finishedAt || null
    } : { state: 'none' };

    const readRoots = (b) => {
        const list = Array.isArray(b.paths) ? b.paths : [];
        const roots = list.map(p => resolveSafe(p));
        if (!roots.length) throw new Error('No folder selected');
        if (roots.some(r => r === LIBRARY_DIR)) throw new Error('Choose folders inside the library');
        return roots;
    };
    const readTypes = (b) => (Array.isArray(b.types) ? b.types : ['.pdf']).filter(t => FOLDER_SOURCE_EXT.includes(t));

    // --- Routes ---
    const register = (app) => {
        app.get('/library/config', (req, res) => res.json({ enabled }));
        if (!enabled) return;

        // Sub-folders of a library folder
        app.get('/library/list', (req, res) => {
            try {
                const abs = resolveSafe(req.query.path);
                const entries = fs.readdirSync(abs, { withFileTypes: true });
                const dirs = entries
                    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('@'))
                    .map(d => d.name)
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
                const files = entries.filter(d => d.isFile() && SOURCE_EXT.includes(path.extname(d.name).toLowerCase())).length;
                res.json({ path: toRel(abs), dirs, files });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        // Create a sub-folder
        app.post('/library/mkdir', express.json(), (req, res) => {
            try {
                const name = String((req.body && req.body.name) || '').trim();
                if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') throw new Error('Invalid folder name');
                const parent = resolveSafe(req.body.path);
                const abs = resolveSafe(path.join(toRel(parent), name));
                fs.mkdirSync(abs);
                chownLike(abs, parent);
                res.json({ path: toRel(abs) });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        // Find the folders of the originals: body = { files: [{ name, size }] }
        app.post('/library/locate', express.json({ limit: '2mb' }), (req, res) => {
            try {
                const files = (req.body && Array.isArray(req.body.files)) ? req.body.files.slice(0, 5000) : [];
                const dirs = files.map(f => {
                    const dir = findOriginalDir(f.name, f.size);
                    return dir ? toRel(dir) : null;
                });
                res.json({ dirs });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        // What would be converted in the selected folders
        app.post('/library/scan', express.json(), (req, res) => {
            try {
                const b = req.body || {};
                const r = scanFolders(readRoots(b), !!b.recursive, readTypes(b), String(b.format || 'cbz'));
                res.json({ count: r.todo.length, already: r.already });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        // Start converting the selected folders (one job at a time)
        app.post('/library/convert-folders', express.json(), (req, res) => {
            try {
                if (folderJob && folderJob.state === 'running') throw new Error('A folder conversion is already running');
                const b = req.body || {};
                const options = (b.options && typeof b.options === 'object') ? b.options : {};
                if (['pdf', 'folder'].includes(options.format)) throw new Error('Choose an archive format (CBZ, CBR...) to convert folders');
                const roots = readRoots(b);
                const r = scanFolders(roots, !!b.recursive, readTypes(b), options.format || 'cbz');
                folderJob = {
                    state: 'running', label: roots.length === 1 ? '/' + toRel(roots[0]) : '', folderCount: roots.length,
                    files: r.todo, skipped: r.already, done: 0, errors: [], current: [], options,
                    cancelled: false, startedAt: Date.now()
                };
                logInfo(`[LIBRARY] Folder conversion ${folderJob.label || roots.length + ' folders'}: ${r.todo.length} file(s) to convert, ${r.already} already done`);
                runFolderJob(folderJob).catch(e => { folderJob.state = 'done'; logWarn(`[LIBRARY] ${e.message}`); });
                res.json(jobView(folderJob));
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        app.get('/library/folder-job', (req, res) => res.json(jobView(folderJob)));
        app.post('/library/folder-job/cancel', (req, res) => {
            if (folderJob && folderJob.state === 'running') folderJob.cancelled = true;
            res.json(jobView(folderJob));
        });
    };

    // --- Called by /convert: move the converted files to the requested destination ---
    // results: [{ name, path, ... }] (updated in place), uploads: multer files
    // Returns a label describing where the files went, or null (default output folder).
    const deliver = (results, destDir, uploads) => {
        if (!enabled || !destDir || !Array.isArray(results) || !results.length) return null;
        const origin = destDir === ORIGIN;
        const errors = [];
        const dirsUsed = new Set();
        let fixedDir = null;
        const byBaseName = {};
        try {
            if (origin) {
                (uploads || []).forEach(u => {
                    const name = path.basename(String(u.originalname).replace(/\\/g, '/'));
                    byBaseName[path.parse(name).name] = { name, size: u.size };
                });
            } else {
                fixedDir = resolveSafe(destDir);
                if (!fs.statSync(fixedDir).isDirectory()) throw new Error(`Not a folder: ${destDir}`);
            }
        } catch (e) {
            logWarn(`[LIBRARY] Invalid destination: ${e.message}`);
            return `kept in output (destination error: ${e.message})`;
        }

        for (const r of results) {
            try {
                let dir = fixedDir;
                if (origin) {
                    const up = byBaseName[path.parse(r.name).name] || byBaseName[r.name];
                    dir = up ? findOriginalDir(up.name, up.size) : null;
                    if (!dir) throw new Error('original not found in the library');
                }
                const target = uniqueTarget(dir, r.name);
                moveTo(r.path, target);
                chownLike(target, dir);
                logInfo(`[LIBRARY] ${r.name} -> ${target}`);
                dirsUsed.add(dir);
                r.path = target;
                r.name = path.basename(target);
            } catch (e) {
                errors.push(`${r.name}: ${e.message}`);
                logWarn(`[LIBRARY] ${r.name} kept in output: ${e.message}`);
            }
        }

        let label = dirsUsed.size === 1 ? Array.from(dirsUsed)[0] : `${dirsUsed.size} library folders`;
        if (!dirsUsed.size) label = '';
        if (errors.length) label += `${label ? ' — ' : ''}kept in output: ${errors.join(' ; ')}`;
        return label;
    };

    return { enabled, register, deliver, ORIGIN };
};

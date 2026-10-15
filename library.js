// Library destination (optional feature, enabled with LIBRARY_DIR)
// ------------------------------------------------------------------
// Lets the user choose, from the web UI, where converted files are placed:
//   - next to the original file (found in the library by name, and size when ambiguous)
//   - or any folder of the library (folder browser in the UI)
// Converted files are never overwritten: "Name.cbz" becomes "Name (2).cbz" if needed.
const path = require('path');
const fs = require('fs');
const express = require('express');

const ORIGIN = ':origin';
const SOURCE_EXT = ['.pdf', '.cbz', '.cbr', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.tar', '.epub'];
const INDEX_TTL_MS = 2 * 60 * 1000;

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

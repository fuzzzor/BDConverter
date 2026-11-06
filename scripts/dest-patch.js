// BDConverter - "Destination" add-on (preloaded with: node -r ./dest-patch.js server.js)
// Lets the user pick, from the web UI, a folder of the mounted library where converted
// files are placed (e.g. next to the original). Nothing is ever overwritten.
// Also adds a ComicInfo.xml (series, number, title, year) inside the generated archives.
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const childProcess = require('child_process');
let comicInfo = null;
try { comicInfo = require('./comicinfo-addon.js'); } catch (e) { console.log('[DEST] comicinfo-addon.js absent : ' + e.message); }

const DEST_ROOT = path.resolve(process.env.DEST_ROOT || '/library');

function log(msg) { console.log('[DEST] ' + msg); }

// Resolve a path relative to DEST_ROOT, refusing anything outside of it.
function resolveSafe(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(DEST_ROOT, clean);
  if (abs !== DEST_ROOT && !abs.startsWith(DEST_ROOT + path.sep)) throw new Error('Chemin refusé');
  return abs;
}

function toRel(abs) { return path.relative(DEST_ROOT, abs).split(path.sep).join('/'); }

// Never overwrite: "Nom.cbz" -> "Nom (2).cbz" -> "Nom (3).cbz"...
function uniqueTarget(dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i++) {
    target = path.join(dir, base + ' (' + i + ')' + ext);
    if (!fs.existsSync(target)) return target;
  }
  throw new Error('Trop de doublons pour ' + name);
}

// Give the new file the same owner as the destination folder (container runs as root).
function chownLike(target, dir) {
  try {
    const st = fs.statSync(dir);
    const walk = (p) => {
      fs.chownSync(p, st.uid, st.gid);
      if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((f) => walk(path.join(p, f)));
    };
    walk(target);
  } catch (e) { log('chown ignoré : ' + e.message); }
}

function moveTo(src, target) {
  try {
    fs.renameSync(src, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, target, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

const ORIGIN = ':origine';
const SOURCE_EXT = ['.pdf', '.cbz', '.cbr', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.tar', '.epub'];

// Index of the library: file name (lower case) -> [{ dir, size }]. Rebuilt at most every 2 minutes.
let libIndex = null;
let libIndexTime = 0;
function getIndex() {
  if (libIndex && Date.now() - libIndexTime < 120000) return libIndex;
  const t0 = Date.now();
  const idx = new Map();
  const stack = [DEST_ROOT];
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
  libIndex = idx;
  libIndexTime = Date.now();
  log('Bibliothèque indexée : ' + count + ' fichiers en ' + (Date.now() - t0) + ' ms');
  return idx;
}

// Folder of the original file: same name, and same size when there are several candidates.
function findOriginalDir(name, size) {
  let cands = getIndex().get(name.toLowerCase()) || [];
  if (!cands.length && Date.now() - libIndexTime > 10000) { libIndex = null; cands = getIndex().get(name.toLowerCase()) || []; }
  if (!cands.length) return null;
  const sameSize = cands.filter((c) => { try { return fs.statSync(c.path).size === size; } catch (e) { return false; } });
  if (sameSize.length) return sameSize[0].dir;
  return cands.length === 1 ? cands[0].dir : null;
}

// Same, from the name without extension (the server only knows "Name", not "Name.pdf")
function findOriginalDirByStem(stem) {
  const key = String(stem).toLowerCase();
  const dirs = new Set();
  for (const [name, cands] of getIndex()) {
    if (path.parse(name).name === key) cands.forEach((c) => dirs.add(c.dir));
  }
  return dirs.size === 1 ? Array.from(dirs)[0] : null;
}

// ---------- ComicInfo.xml ----------
// The conversions currently running: by file name (stem) when known, else the last one
let currentJob = null;
const jobsByStem = new Map();

// BDConverter builds each archive with "7z a / rar a / tar -cf" run in the folder of the pages:
// ComicInfo.xml is written in that folder just before, so it ends up inside the archive.
function maybeWriteComicInfo(cmd, opts) {
  if (!comicInfo) return;
  if (!opts || typeof opts !== 'object' || !opts.cwd) return;
  if (!/^(7z a |rar a |tar -cf )/.test(String(cmd))) return;
  const dirName = path.basename(opts.cwd);
  let src = null;
  const m = dirName.match(/^(.*)_temp_\d+$/);
  if (m) {
    const stem = m[1];
    const job = jobsByStem.get(stem.toLowerCase()) || currentJob;
    if (!job || !job.ci) return;
    let folder = job.folder || '';
    if (job.destDir === ORIGIN) {
      const d = findOriginalDirByStem(stem);
      if (d) folder = path.basename(d);
    } else if (job.destDir) {
      try { folder = path.basename(resolveSafe(job.destDir)); } catch (e) {}
    }
    src = (folder ? folder + '/' : '') + stem;
  } else if (/^merge_/.test(dirName)) {
    if (!currentJob || !currentJob.ci) return;
    src = currentJob.merge || null;
  }
  if (!src) return;
  const info = comicInfo.writeComicInfo(opts.cwd, src);
  if (info) log('ComicInfo : ' + src + ' -> série "' + info.series + '"' + (info.number ? ' n°' + info.number : ''));
}

const origExec = childProcess.exec;
childProcess.exec = function (cmd, opts) {
  try { maybeWriteComicInfo(cmd, opts); } catch (e) { log('ComicInfo ignoré : ' + e.message); }
  return origExec.apply(this, arguments);
};

// ---------- Convert a whole library folder directly on the server ----------
// The files are read from the server's disk and sent to BDConverter's own /convert on 127.0.0.1:
// nothing goes through the browser, and the conversion goes on even if the page is closed.
const http = require('http');
const PORT = Number(process.env.PORT || 3111);
const FOLDER_CONCURRENCY = Math.max(1, Number(process.env.FOLDER_CONCURRENCY || 2));
const FOLDER_SOURCE_EXT = ['.pdf', '.cbr', '.cbz', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.tar'];
let folderJob = null;

function outputExt(format) {
  if (format === 'rar4') return '.cbr';
  return '.' + (format || 'cbz');
}

// Files to convert in a folder (optionally its sub-folders), and those already converted
function scanFolder(roots, recursive, types, format) {
  const ext = outputExt(format);
  const todo = [];
  const seen = new Set();
  let already = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('@') || e.name === '#recycle') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(p); continue; }
      const x = path.extname(e.name).toLowerCase();
      if (!e.isFile() || !types.includes(x) || x === ext) continue;
      if (seen.has(p)) continue; // folder selected twice (or with one of its parents)
      seen.add(p);
      const stem = e.name.slice(0, -x.length);
      if (fs.existsSync(path.join(d, stem + ext))) { already++; continue; }
      todo.push(p);
    }
  };
  (Array.isArray(roots) ? roots : [roots]).forEach(walk);
  return { todo, already };
}

// Send one file of the library to /convert (multipart built by hand, no time limit)
function convertOne(file, options, ci) {
  return new Promise((resolve, reject) => {
    const name = path.basename(file);
    const dir = path.dirname(file);
    const stem = name.slice(0, -path.extname(name).length);
    const boundary = '----bdcfolder' + Date.now() + Math.random().toString(36).slice(2);
    const fields = Object.assign({}, options, {
      filePaths: JSON.stringify([name]),
      requestId: 'folder-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    });
    let headStr = '';
    Object.keys(fields).forEach((k) => {
      headStr += '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n';
    });
    headStr += '--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' +
      name.replace(/"/g, '_') + '"\r\nContent-Type: application/octet-stream\r\n\r\n';
    const head = Buffer.from(headStr, 'utf8');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
    const size = fs.statSync(file).size;
    const qs = '?ci=' + (ci ? '1' : '0') + '&folder=' + encodeURIComponent(path.basename(dir)) +
      '&dest=' + encodeURIComponent(toRel(dir)) + '&stem=' + encodeURIComponent(stem);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/convert' + qs,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': head.length + size + tail.length }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(data.slice(0, 200) || ('HTTP ' + res.statusCode)));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('réponse illisible')); }
      });
    });
    req.on('error', reject);
    req.write(head);
    const rs = fs.createReadStream(file);
    rs.on('error', (e) => { req.destroy(e); reject(e); });
    rs.on('end', () => req.end(tail));
    rs.pipe(req, { end: false });
  });
}

async function runFolderJob(job) {
  let next = 0;
  const worker = async () => {
    while (!job.cancelled && next < job.files.length) {
      const file = job.files[next++];
      const rel = toRel(file);
      job.current.push(rel);
      try {
        const res = await convertOne(file, job.options, job.ci);
        const n = (res.stats && res.stats.totalFiles) || 0;
        if (!n) throw new Error('aucun fichier produit');
        job.done++;
      } catch (e) {
        job.errors.push(rel + ' : ' + e.message);
        log('Dossier : ERREUR ' + rel + ' : ' + e.message);
      }
      job.current = job.current.filter((c) => c !== rel);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(job.concurrency, job.files.length); i++) workers.push(worker());
  await Promise.all(workers);
  job.state = job.cancelled ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  log('Dossier : ' + job.root + ' terminé — ' + job.done + ' converti(s), ' + job.errors.length + ' erreur(s)');
}

function jobView(job) {
  if (!job) return { state: 'none' };
  return {
    id: job.id, state: job.state, root: job.root, total: job.files.length, done: job.done,
    errors: job.errors.slice(-20), errorCount: job.errors.length, current: job.current,
    skipped: job.skipped, startedAt: job.startedAt, finishedAt: job.finishedAt || null
  };
}

function install(app, express) {
  // What would be converted in a folder
  const readRoots = (b) => {
    const list = Array.isArray(b.paths) ? b.paths : [b.path];
    const roots = list.filter((p) => p !== undefined && p !== null).map((p) => resolveSafe(p));
    if (!roots.length) throw new Error('Aucun dossier choisi');
    if (roots.some((r) => r === DEST_ROOT)) throw new Error('Choisis des dossiers à l\'intérieur de la bibliothèque');
    return roots;
  };
  app.post('/dest/scan', express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const roots = readRoots(b);
      const types = (Array.isArray(b.types) ? b.types : ['.pdf']).filter((t) => FOLDER_SOURCE_EXT.includes(t));
      const r = scanFolder(roots, !!b.recursive, types, String(b.format || 'cbz'));
      res.json({ paths: roots.map(toRel), count: r.todo.length, already: r.already });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Start converting a folder
  app.post('/dest/convert-folder', express.json(), (req, res) => {
    try {
      if (folderJob && folderJob.state === 'running') throw new Error('Une conversion de dossier est déjà en cours');
      const b = req.body || {};
      const options = b.options || {};
      if (['pdf', 'folder'].includes(options.format)) throw new Error('Choisis un format d\'archive (CBZ, CBR…) pour convertir un dossier');
      const roots = readRoots(b);
      const types = (Array.isArray(b.types) ? b.types : ['.pdf']).filter((t) => FOLDER_SOURCE_EXT.includes(t));
      const r = scanFolder(roots, !!b.recursive, types, options.format || 'cbz');
      const label = roots.length === 1 ? '/' + toRel(roots[0]) : roots.length + ' dossiers';
      folderJob = {
        id: Date.now().toString(36), state: 'running', root: label, files: r.todo, skipped: r.already,
        done: 0, errors: [], current: [], options, ci: b.ci !== false,
        concurrency: FOLDER_CONCURRENCY, cancelled: false, startedAt: Date.now()
      };
      log('Dossier : ' + folderJob.root + ' — ' + r.todo.length + ' fichier(s) à convertir, ' + r.already + ' déjà fait(s)');
      runFolderJob(folderJob).catch((e) => { folderJob.state = 'done'; log('Dossier : ' + e.message); });
      res.json(jobView(folderJob));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/dest/folder-job', (req, res) => res.json(jobView(folderJob)));
  app.post('/dest/folder-job/cancel', (req, res) => {
    if (folderJob && folderJob.state === 'running') folderJob.cancelled = true;
    res.json(jobView(folderJob));
  });

  // List sub-folders of a library folder
  app.get('/dest/list', (req, res) => {
    try {
      const abs = resolveSafe(req.query.path);
      const dirs = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('@'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' }));
      const files = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isFile() && ['.pdf', '.cbz', '.cbr', '.cb7', '.cbt', '.epub'].includes(path.extname(d.name).toLowerCase())).length;
      res.json({ root: DEST_ROOT, path: toRel(abs), dirs: dirs, files: files });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Find the folder of the originals: body = { files: [{ name, size }] }
  app.post('/dest/locate', express.json({ limit: '2mb' }), (req, res) => {
    try {
      const files = (req.body && Array.isArray(req.body.files)) ? req.body.files.slice(0, 2000) : [];
      const out = files.map((f) => {
        const name = path.basename(String(f.name || '').replace(/\\/g, '/'));
        const dir = name ? findOriginalDir(name, Number(f.size)) : null;
        return dir ? toRel(dir) : null;
      });
      res.json({ dirs: out });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Create a sub-folder
  app.post('/dest/mkdir', express.json(), (req, res) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') throw new Error('Nom de dossier invalide');
      const parent = resolveSafe(req.body.path);
      const abs = resolveSafe(path.join(toRel(parent), name));
      fs.mkdirSync(abs);
      chownLike(abs, parent);
      res.json({ path: toRel(abs) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // After /convert finishes, move the results into the chosen folder
  // destDir = 'a/b'      -> that library folder
  // destDir = ':origine' -> next to the original file, found in the library by name (+ size)
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/convert') return next();
    const job = {
      ci: req.query.ci === '1',
      folder: String(req.query.folder || ''),
      merge: String(req.query.merge || ''),
      destDir: String(req.query.dest || '')
    };
    const stemKey = req.query.stem ? String(req.query.stem).toLowerCase() : null;
    if (stemKey) jobsByStem.set(stemKey, job); else currentJob = job;
    res.on('close', () => { if (stemKey) jobsByStem.delete(stemKey); else if (currentJob === job) currentJob = null; });
    const origJson = res.json.bind(res);
    res.json = function (body) {
      const destRel = (req.body && req.body.destDir) || (req.query && req.query.dest) || '';
      if (destRel && body && body.stats && Array.isArray(body.stats.files)) {
        const origin = destRel === ORIGIN;
        const errors = [];
        const dirsUsed = new Set();
        try {
          let fixedDir = null;
          let uploads = null;
          if (origin) {
            uploads = {};
            (req.files || []).forEach((u) => {
              const name = path.basename(String(u.originalname).replace(/\\/g, '/'));
              uploads[path.parse(name).name] = { name: name, size: u.size };
            });
          } else {
            fixedDir = resolveSafe(destRel);
            if (!fs.statSync(fixedDir).isDirectory()) throw new Error('Pas un dossier : ' + destRel);
          }
          body.stats.files.forEach((f) => {
            try {
              let dir = fixedDir;
              if (origin) {
                const up = uploads[path.parse(f.name).name] || uploads[f.name];
                if (!up) throw new Error('original inconnu');
                dir = findOriginalDir(up.name, up.size);
                if (!dir) throw new Error('original introuvable dans la bibliothèque');
              }
              const target = uniqueTarget(dir, f.name);
              moveTo(f.path, target);
              chownLike(target, dir);
              log(f.name + ' -> ' + target);
              dirsUsed.add(dir);
              f.path = target;
              f.name = path.basename(target);
            } catch (e) {
              errors.push(f.name + ' : ' + e.message);
              log('ERREUR ' + f.name + ' : ' + e.message);
            }
          });
          let label;
          if (origin) label = dirsUsed.size === 0 ? 'dossier output' : dirsUsed.size === 1 ? Array.from(dirsUsed)[0] : 'à côté des originaux (' + dirsUsed.size + ' dossiers)';
          else label = fixedDir;
          if (errors.length) label += '  — restés dans output : ' + errors.join(' ; ');
          body.stats.outputDir = label;
        } catch (e) {
          body.stats.outputDir = body.stats.outputDir + '  (destination impossible : ' + e.message + ')';
          log('ERREUR destination : ' + e.message);
        }
      }
      return origJson(body);
    };
    next();
  });

  // Serve index.html with the add-on script injected
  const indexPath = path.join(process.cwd(), 'index.html');
  const sendIndex = (req, res) => {
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace('</body>', '<script src="dest-ui.js"></script>\n</body>');
    res.type('html').send(html);
  };
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
  app.get('/dest-ui.js', (req, res) => res.sendFile(path.join(__dirname, 'dest-ui.js')));
  log('Add-on destination actif, racine : ' + DEST_ROOT);

  // No time limit on uploads (Node cuts requests after 5 minutes by default)
  const origListen = app.listen;
  app.listen = function () {
    const srv = origListen.apply(this, arguments);
    srv.requestTimeout = 0;
    return srv;
  };
}

// Hook express() so the add-on is installed on the app before server.js adds its routes
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exp = origLoad.apply(this, arguments);
  if (request === 'express' && !exp.__destPatched) {
    const wrapped = function () {
      const app = exp.apply(this, arguments);
      try { install(app, exp); } catch (e) { log('install error: ' + e.message); }
      return app;
    };
    Object.keys(exp).forEach((k) => { wrapped[k] = exp[k]; });
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(exp));
    wrapped.__destPatched = true;
    Module._load = origLoad; // only once
    return wrapped;
  }
  return exp;
};

// BDConverter - "Destination" add-on (UI). No dollar character allowed in this file.
(function () {
  'use strict';
  var KEY = 'bdc-destDir';
  var ORIGIN = ':origine';
  var OUTPUT = ':output';
  // Default: next to the original file
  var destDir = ORIGIN;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === OUTPUT) destDir = '';
    else if (saved) destDir = saved;
  } catch (e) {}

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') n.style.cssText = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function getSelected() {
    try { return (typeof selectedFiles !== 'undefined' && Array.isArray(selectedFiles)) ? selectedFiles : []; } catch (e) { return []; }
  }

  // ---------- Control in the settings panel ----------
  var formatSel = document.getElementById('format');
  var anchor = formatSel ? formatSel.closest('.control-group') : null;
  if (!anchor) return;

  var group = el('div', { 'class': 'control-group', style: 'grid-column: 1 / -1;' });
  group.appendChild(el('label', null, 'Destination des fichiers convertis'));
  var row = el('div', { style: 'display:flex; gap:10px; align-items:center;' });
  var display = el('select', { style: 'flex:1; min-width:0; cursor:pointer;', title: 'Où déposer les fichiers convertis' });
  var btnBrowse = el('button', { type: 'button', 'class': 'modal-btn btn-primary', style: 'white-space:nowrap; padding:8px 14px;' }, 'Parcourir…');
  row.appendChild(display); row.appendChild(btnBrowse);
  group.appendChild(row);
  var hint = el('div', { style: 'font-size:.75em; opacity:.8; margin-top:4px; word-break:break-word;' });
  group.appendChild(hint);

  // ComicInfo.xml option (remembered, on by default)
  var CI_KEY = 'bdc-comicinfo';
  var ciOn = true;
  try { ciOn = localStorage.getItem(CI_KEY) !== '0'; } catch (e) {}
  var ciRow = el('label', { 'class': 'toggle-row', style: 'margin-top:8px;',
    title: 'Ajoute un fichier ComicInfo.xml (série, numéro, titre, année) dans les CBZ/CBR, lu par Kavita' });
  var ciSwitch = el('span', { 'class': 'toggle-switch' });
  var ciBox = el('input', { type: 'checkbox', id: 'addComicInfo' });
  ciBox.checked = ciOn;
  ciSwitch.appendChild(ciBox);
  ciSwitch.appendChild(el('span', { 'class': 'toggle-slider' }));
  ciRow.appendChild(ciSwitch);
  ciRow.appendChild(el('span', { 'class': 'toggle-text' }, 'Ajouter ComicInfo.xml (série et numéro pour Kavita)'));
  group.appendChild(ciRow);
  ciBox.addEventListener('change', function () {
    try { localStorage.setItem(CI_KEY, ciBox.checked ? '1' : '0'); } catch (e) {}
  });
  anchor.parentNode.insertBefore(group, anchor.nextSibling);

  function opt(value, label) { display.appendChild(el('option', { value: value }, label)); }
  function refreshDisplay() {
    display.textContent = '';
    opt(ORIGIN, '📍 À côté du fichier d\'origine (automatique)');
    opt('', 'Dossier par défaut (output)');
    if (destDir && destDir !== ORIGIN) opt(destDir, '📁 ' + destDir);
    opt('__browse', '📂 Choisir un dossier…');
    display.value = destDir;
    refreshHint();
  }
  function setDest(v) {
    destDir = v || '';
    try { localStorage.setItem(KEY, destDir || OUTPUT); } catch (e) {}
    refreshDisplay();
  }
  display.addEventListener('change', function () {
    if (display.value === '__browse') { display.value = destDir; openBrowser(); }
    else setDest(display.value);
  });

  // ---------- Locate the originals of the selected files ----------
  var located = { key: '', dirs: [] };
  function filesKey(files) { return files.map(function (f) { return f.name + ':' + f.size; }).join('|'); }
  function locate(files) {
    var key = filesKey(files);
    if (key === located.key) return Promise.resolve(located.dirs);
    return fetch('/dest/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files.map(function (f) { return { name: f.name, size: f.size }; }) }) })
      .then(function (r) { return r.json(); })
      .then(function (data) { located = { key: key, dirs: data.dirs || [] }; return located.dirs; })
      .catch(function () { return []; });
  }
  function refreshHint() {
    if (destDir !== ORIGIN) { hint.textContent = ''; return; }
    var files = getSelected().filter(function (f) { return !/\.(jpe?g|png|tiff?|bmp|webp)/i.test(f.name); });
    if (!files.length) {
      hint.textContent = 'Chaque fichier converti sera posé à côté de son original (retrouvé dans la bibliothèque par son nom).';
      return;
    }
    hint.textContent = 'Recherche des originaux…';
    locate(files).then(function (dirs) {
      if (destDir !== ORIGIN) return;
      var found = dirs.filter(Boolean);
      var uniq = found.filter(function (d, i) { return found.indexOf(d) === i; });
      var missing = files.length - found.length;
      var txt;
      if (!found.length) txt = '⚠️ Original introuvable dans la bibliothèque : le converti restera dans output.';
      else if (uniq.length === 1) txt = '✅ Destination : /' + uniq[0];
      else txt = '✅ ' + found.length + ' fichier(s) retrouvé(s), dans ' + uniq.length + ' dossiers différents';
      if (found.length && missing) txt += ' — ⚠️ ' + missing + ' introuvable(s), ils resteront dans output';
      hint.textContent = txt;
    });
  }
  // Watch the file selection
  var lastKey = '';
  setInterval(function () {
    var k = filesKey(getSelected());
    if (k !== lastKey) { lastKey = k; refreshHint(); }
  }, 800);

  // ---------- Folder browser modal ----------
  var modal = el('div', { 'class': 'modal', id: 'dest-modal' });
  var box = el('div', { 'class': 'modal-content', style: 'text-align:left; width:640px;' });
  var modalTitle = el('h2', { style: 'text-align:center;' }, '📁 Choisir la destination');
  box.appendChild(modalTitle);
  var bOrigin = el('button', { type: 'button', 'class': 'modal-btn btn-primary', style: 'width:100%; margin:6px 0 4px;' },
    '📍 À côté du fichier d\'origine (automatique)');
  var originInfo = el('div', { style: 'font-size:.75em; opacity:.75; text-align:center; margin-bottom:10px;' });
  var crumb = el('div', { style: 'margin:10px 0 4px; font-family:monospace; word-break:break-all; opacity:.9;' });
  var info = el('div', { style: 'font-size:.8em; opacity:.7; margin-bottom:8px;' });
  var list = el('div', { style: 'max-height:40vh; overflow:auto; border:1px solid rgba(128,128,128,.4); border-radius:6px;' });
  var actions = el('div', { 'class': 'modal-actions', style: 'flex-wrap:wrap;' });
  var bNew = el('button', { type: 'button', 'class': 'modal-btn btn-secondary' }, '＋ Nouveau dossier');
  var bCancel = el('button', { type: 'button', 'class': 'modal-btn btn-secondary' }, 'Annuler');
  var bPick = el('button', { type: 'button', 'class': 'modal-btn btn-primary' }, 'Choisir ce dossier');
  actions.appendChild(bNew); actions.appendChild(bCancel); actions.appendChild(bPick);
  // Options shown only when converting a whole folder
  var convOpts = el('div', { style: 'display:none; margin:10px 0; font-size:.9em;' });
  var optRec = el('input', { type: 'checkbox' }); optRec.checked = true;
  var optCbr = el('input', { type: 'checkbox' });
  var l1 = el('label', { style: 'display:block; cursor:pointer;' }); l1.appendChild(optRec); l1.appendChild(document.createTextNode(' Inclure les sous-dossiers'));
  var l2 = el('label', { style: 'display:block; cursor:pointer;' }); l2.appendChild(optCbr); l2.appendChild(document.createTextNode(' Convertir aussi les CBR (en plus des PDF)'));
  convOpts.appendChild(l1); convOpts.appendChild(l2);
  // Several folders can be ticked, even in different places of the library
  var selection = [];
  var selBox = el('div', { style: 'margin-top:8px; word-break:break-word;' });
  convOpts.insertBefore(selBox, l1);
  function selLabel(p) { return p.split('/').pop() || p; }
  function renderSelection() {
    selBox.textContent = '';
    if (!selection.length) {
      selBox.appendChild(el('div', { style: 'opacity:.7;' }, 'Coche un ou plusieurs dossiers (☐), ou convertis le dossier affiché.'));
    } else {
      selBox.appendChild(el('b', null, '✅ Sélection (' + selection.length + ') : '));
      selection.forEach(function (p) {
        var chip = el('span', { style: 'display:inline-block; margin:2px 4px; padding:2px 8px; border-radius:10px; background:rgba(255,152,0,.2); cursor:pointer;',
          title: '/' + p + ' — cliquer pour retirer' }, selLabel(p) + ' ✕');
        chip.addEventListener('click', function () { toggleSel(p); });
        selBox.appendChild(chip);
      });
      var clear = el('a', { href: '#', style: 'margin-left:6px; font-size:.9em;' }, 'tout retirer');
      clear.addEventListener('click', function (e) { e.preventDefault(); selection = []; renderSelection(); refreshMarks(); });
      selBox.appendChild(clear);
    }
    if (browseMode === 'convert') bPick.textContent = selection.length ? '▶ Convertir la sélection (' + selection.length + ')' : '▶ Convertir ce dossier';
  }
  // Rows of the folder currently listed (to update the boxes in place, without reloading the
  // list: the list keeps its scroll position)
  var selRows = [];
  var lastSelIdx = null;
  function setSel(p, on) {
    var i = selection.indexOf(p);
    if (on && i < 0) selection.push(p);
    if (!on && i >= 0) selection.splice(i, 1);
  }
  function refreshMarks() {
    selRows.forEach(function (r) {
      var on = selection.indexOf(r.full) >= 0;
      r.box.textContent = on ? '☑' : '☐';
      r.row.style.fontWeight = on ? 'bold' : '';
    });
  }
  function toggleSel(p) {
    setSel(p, selection.indexOf(p) < 0);
    renderSelection();
    refreshMarks();
  }
  // Click on a box; with Shift, every folder between the previous click and this one
  function clickSel(idx, shift) {
    var target = selRows[idx];
    var on = selection.indexOf(target.full) < 0;
    if (shift && lastSelIdx !== null && lastSelIdx < selRows.length) {
      var a = Math.min(lastSelIdx, idx), b = Math.max(lastSelIdx, idx);
      for (var k = a; k <= b; k++) setSel(selRows[k].full, on);
    } else {
      setSel(target.full, on);
    }
    lastSelIdx = idx;
    renderSelection();
    refreshMarks();
  }
  [bOrigin, originInfo, crumb, info, list, convOpts, actions].forEach(function (n) { box.appendChild(n); });
  var browseMode = 'dest';
  modal.appendChild(box);
  document.body.appendChild(modal);

  var current = '';

  function item(label, onClick, bold) {
    var it = el('div', { style: 'padding:8px 12px; cursor:pointer; border-bottom:1px solid rgba(128,128,128,.2);' +
      (bold ? 'font-weight:bold;' : '') }, label);
    it.addEventListener('mouseenter', function () { it.style.background = 'rgba(255,152,0,.15)'; });
    it.addEventListener('mouseleave', function () { it.style.background = ''; });
    it.addEventListener('click', onClick);
    return it;
  }

  function load(p) {
    list.textContent = 'Chargement…';
    fetch('/dest/list?path=' + encodeURIComponent(p || ''))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        current = data.path || '';
        crumb.textContent = '📂 /' + current;
        info.textContent = data.dirs.length + ' sous-dossier(s) • ' + data.files + ' BD/PDF dans ce dossier';
        list.textContent = '';
        if (current) {
          var parent = current.split('/').slice(0, -1).join('/');
          list.appendChild(item('⬆️  .. (dossier parent)', function () { load(parent); }, true));
        }
        if (!data.dirs.length) list.appendChild(el('div', { style: 'padding:8px 12px; opacity:.6;' }, '(aucun sous-dossier)'));
        selRows = [];
        lastSelIdx = null;
        if (browseMode === 'convert' && data.dirs.length > 1) {
          var all = item('☑  Tout cocher / décocher dans ce dossier (Maj+clic sur ☐ = plage)', function () {
            var allOn = selRows.every(function (r) { return selection.indexOf(r.full) >= 0; });
            selRows.forEach(function (r) { setSel(r.full, !allOn); });
            renderSelection();
            refreshMarks();
          }, false);
          all.style.opacity = '.8';
          all.style.fontSize = '.9em';
          list.appendChild(all);
        }
        data.dirs.forEach(function (d) {
          var full = current ? current + '/' + d : d;
          var row = item('📁  ' + d, function () { load(full); });
          if (browseMode === 'convert') {
            // tick box: select the folder without entering it
            var on = selection.indexOf(full) >= 0;
            var box = el('span', { 'class': 'bdc-sel', style: 'display:inline-block; width:1.8em; font-size:1.15em; cursor:pointer; user-select:none;',
              title: 'Cocher / décocher (Maj+clic : toute la plage depuis la dernière case)' }, on ? '☑' : '☐');
            var idx = selRows.length;
            selRows.push({ full: full, box: box, row: row });
            box.addEventListener('mousedown', function (e) { if (e.shiftKey) e.preventDefault(); }); // no text selection
            box.addEventListener('click', function (e) { e.stopPropagation(); clickSel(idx, e.shiftKey); });
            row.insertBefore(box, row.firstChild);
            if (on) row.style.fontWeight = 'bold';
          }
          list.appendChild(row);
        });
      })
      .catch(function (e) {
        list.textContent = 'Erreur : ' + e.message;
        if (p) setTimeout(function () { load(''); }, 1200);
      });
  }

  // Opens directly in the folder of the original when it can be found
  function setMode(mode) {
    browseMode = mode;
    var conv = mode === 'convert';
    modalTitle.textContent = conv ? '🗂️ Convertir un dossier du serveur' : '📁 Choisir la destination';
    bOrigin.style.display = conv ? 'none' : '';
    originInfo.style.display = conv ? 'none' : '';
    convOpts.style.display = conv ? '' : 'none';
    bNew.style.display = conv ? 'none' : '';
    bPick.textContent = conv ? '▶ Convertir ce dossier' : 'Choisir ce dossier';
    if (conv) renderSelection();
  }
  function openBrowser() {
    setMode('dest');
    modal.style.display = 'flex';
    originInfo.textContent = '';
    var files = getSelected();
    if (destDir && destDir !== ORIGIN) { load(destDir); return; }
    if (!files.length) { load(''); return; }
    list.textContent = 'Recherche du dossier d\'origine…';
    locate(files).then(function (dirs) {
      var first = dirs.filter(Boolean)[0];
      originInfo.textContent = first ? 'Original trouvé dans : /' + first : 'Original introuvable dans la bibliothèque';
      load(first || '');
    });
  }
  function close() { modal.style.display = 'none'; }
  btnBrowse.addEventListener('click', openBrowser);
  bCancel.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  bOrigin.addEventListener('click', function () { setDest(ORIGIN); close(); });
  bPick.addEventListener('click', function () {
    if (!current && !(browseMode === 'convert' && selection.length)) { alert('Choisis un dossier à l\'intérieur de la bibliothèque.'); return; }
    if (browseMode === 'convert') { startFolder(selection.length ? selection.slice() : [current]); return; }
    setDest(current); close();
  });
  bNew.addEventListener('click', function () {
    var name = prompt('Nom du nouveau dossier :');
    if (!name) return;
    fetch('/dest/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current, name: name.trim() }) })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data.error) throw new Error(data.error); load(data.path); })
      .catch(function (e) { alert('Erreur : ' + e.message); });
  });

  refreshDisplay();

  // ---------- Convert a whole folder directly on the server ----------
  var LAST_FOLDER = 'bdc-lastFolder';
  var btnFolder = el('button', { type: 'button', 'class': 'modal-btn btn-secondary', style: 'width:100%; margin-top:10px;' },
    '🗂️ Convertir directement un dossier du serveur…');
  var jobBox = el('div', { style: 'display:none; margin-top:8px; padding:10px; border:1px solid rgba(128,128,128,.4); border-radius:6px; font-size:.85em;' });
  var jobText = el('div', { style: 'word-break:break-word;' });
  var jobBarWrap = el('div', { style: 'height:8px; background:rgba(128,128,128,.3); border-radius:4px; margin:6px 0; overflow:hidden;' });
  var jobBar = el('div', { style: 'height:100%; width:0; background:#FF9800; transition:width .5s;' });
  jobBarWrap.appendChild(jobBar);
  var jobCurrent = el('div', { style: 'opacity:.75; word-break:break-all;' });
  var jobErrors = el('div', { style: 'color:#e57373; word-break:break-word; margin-top:4px;' });
  var btnStop = el('button', { type: 'button', 'class': 'modal-btn btn-secondary', style: 'margin-top:6px; padding:6px 12px;' }, '⏹ Arrêter');
  [jobText, jobBarWrap, jobCurrent, jobErrors, btnStop].forEach(function (n) { jobBox.appendChild(n); });
  group.appendChild(btnFolder);
  group.appendChild(jobBox);

  function readOptions() {
    var v = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
    var c = function (id) { var e = document.getElementById(id); return !!(e && e.checked); };
    var f = function (id) {
      var e = document.getElementById(id);
      try { return e ? String(sliderToFactor(e.value)) : '1'; } catch (x) { return '1'; }
    };
    return {
      dpi: v('dpi'), maxWidth: v('maxWidth'), colorMode: v('colorMode'), format: v('format'),
      compression: v('compression'), archiveCompression: v('archiveCompression'), rotation: v('rotation'),
      imgFormat: v('imgFormat'), splitDouble: v('splitDouble') || 'no', readingDir: v('readingDir') || 'ltr',
      cropMargins: v('crop-margins'), deskew: c('deskew') ? 'true' : 'false', autoContrast: c('auto-contrast') ? 'true' : 'false',
      brightness: f('brightness'), saturation: f('saturation')
    };
  }

  btnFolder.addEventListener('click', function () {
    setMode('convert');
    modal.style.display = 'flex';
    var last = '';
    try { last = localStorage.getItem(LAST_FOLDER) || ''; } catch (e) {}
    load(last);
  });

  function startFolder(folders) {
    var where = folders.length === 1 ? '/' + folders[0] : folders.length + ' dossiers (' + folders.map(selLabel).join(', ') + ')';
    var options = readOptions();
    if (options.format === 'pdf' || options.format === 'folder') {
      alert('Pour convertir un dossier, choisis un format d\'archive (CBZ, CBR…) dans « Format d\'archive ».');
      return;
    }
    var types = ['.pdf'];
    if (optCbr.checked) types.push('.cbr');
    fetch('/dest/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: folders, recursive: optRec.checked, types: types, format: options.format }) })
    .then(function (r) { return r.json(); }).then(function (scan) {
      if (scan.error) throw new Error(scan.error);
      if (!scan.count) {
        alert('Rien à convertir dans ' + where + (scan.already ? ' (' + scan.already + ' fichier(s) déjà converti(s))' : '') + '.');
        return;
      }
      var msg = scan.count + ' fichier(s) à convertir dans ' + where +
        (optRec.checked ? ' (sous-dossiers compris)' : '') + '.\n' +
        (scan.already ? scan.already + ' déjà converti(s) seront ignorés.\n' : '') +
        '\nChaque fichier converti sera posé à côté de son original' + (ciBox.checked ? ', avec son ComicInfo.xml' : '') +
        '.\nLes réglages actuels (mode, format, compression…) seront utilisés.\n\nLancer la conversion ?';
      if (!confirm(msg)) return;
      try { localStorage.setItem(LAST_FOLDER, folders[folders.length - 1].split('/').slice(0, -1).join('/') || folders[0]); } catch (e) {}
      return fetch('/dest/convert-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: folders, recursive: optRec.checked, types: types, options: options, ci: ciBox.checked })
      }).then(function (r) { return r.json(); }).then(function (job) {
        if (job.error) throw new Error(job.error);
        selection = [];
        close();
        showJob(job);
        poll();
      });
    }).catch(function (e) { alert('Erreur : ' + e.message); });
  }

  function fmtDuration(ms) {
    var s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h ? h + ' h ' + (m % 60) + ' min' : m ? m + ' min ' + (s % 60) + ' s' : s + ' s';
  }

  function showJob(job) {
    if (!job || job.state === 'none') { jobBox.style.display = 'none'; return; }
    jobBox.style.display = '';
    var processed = job.done + job.errorCount;
    var pct = job.total ? Math.round(processed / job.total * 100) : 100;
    jobBar.style.width = pct + '%';
    var elapsed = (job.finishedAt || Date.now()) - job.startedAt;
    var head;
    if (job.state === 'running') {
      var eta = processed ? fmtDuration(elapsed / processed * (job.total - processed)) : '…';
      head = '⏳ ' + job.root + ' : ' + processed + ' / ' + job.total + ' (' + pct + ' %) — reste environ ' + eta;
    } else if (job.state === 'cancelled') {
      head = '⏹ Arrêté : ' + job.done + ' converti(s) sur ' + job.total + ' dans ' + job.root;
    } else {
      head = '✅ Terminé en ' + fmtDuration(elapsed) + ' : ' + job.done + ' converti(s) dans ' + job.root;
    }
    if (job.skipped) head += ' — ' + job.skipped + ' déjà fait(s), ignoré(s)';
    jobText.textContent = head;
    jobCurrent.textContent = job.state === 'running' && job.current.length ? 'En cours : ' + job.current.join(' • ') : '';
    jobErrors.textContent = job.errorCount ? '⚠️ ' + job.errorCount + ' erreur(s) : ' + job.errors.join(' | ') : '';
    btnStop.style.display = job.state === 'running' ? '' : 'none';
    btnFolder.disabled = job.state === 'running';
  }

  var pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    fetch('/dest/folder-job').then(function (r) { return r.json(); }).then(function (job) {
      showJob(job);
      if (job.state === 'running') pollTimer = setTimeout(poll, 2000);
    }).catch(function () { pollTimer = setTimeout(poll, 5000); });
  }
  btnStop.addEventListener('click', function () {
    if (!confirm('Arrêter après les fichiers en cours ?')) return;
    fetch('/dest/folder-job/cancel', { method: 'POST' }).then(function () { poll(); });
  });
  poll(); // shows a conversion already running (e.g. after reloading the page)

  // ---------- Progress counter across batches ----------
  // The conversion is sent in several small requests (see below); the server counts files per
  // request, so its "file x / y" counter is shifted to show the position in the whole batch.
  var batch = { offset: 0, total: 0, active: false };
  var OrigEventSource = window.EventSource;
  window.EventSource = function (u, cfg) {
    var es = new OrigEventSource(u, cfg);
    var userHandler = null;
    Object.defineProperty(es, 'onmessage', {
      get: function () { return userHandler; },
      set: function (h) { userHandler = h; }
    });
    es.addEventListener('message', function (ev) {
      if (!userHandler) return;
      var e = ev;
      if (batch.active) {
        try {
          var d = JSON.parse(ev.data);
          if (typeof d.currentFileIndex === 'number') d.currentFileIndex += batch.offset;
          if (typeof d.totalFiles === 'number') d.totalFiles = batch.total;
          e = new MessageEvent('message', { data: JSON.stringify(d) });
        } catch (x) {}
      }
      userHandler.call(es, e);
    });
    return es;
  };
  window.EventSource.prototype = OrigEventSource.prototype;

  // ---------- Send the conversion ----------
  var IMG_EXT = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'webp'];
  function isImg(p) { return IMG_EXT.indexOf(String(p).split('.').pop().toLowerCase()) >= 0; }

  var origFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (url !== '/convert' || !opts || !(opts.body instanceof FormData)) return origFetch.apply(this, arguments);
    var fd = opts.body;
    var files = fd.getAll('files');
    var paths = [];
    try { paths = JSON.parse(fd.get('filePaths') || '[]'); } catch (e) {}
    if (paths.length !== files.length) paths = files.map(function (f) { return f.name; });

    // Documents inside a folder are sent without their folder (BDConverter would ignore them),
    // images keep their folder (one archive per folder).
    // (the parent folder is kept aside: it gives the series name for ComicInfo.xml)
    var parents = paths.map(function (p) {
      var parts = String(p || '').split(/[\\/]/).filter(Boolean);
      return parts.length > 1 ? parts[parts.length - 2] : '';
    });
    paths = paths.map(function (p) { return (!p || isImg(p)) ? p : String(p).split(/[\\/]/).pop(); });

    // One request per document, one per image folder: avoids a giant upload that the server
    // cuts after 5 minutes, and one failure no longer cancels everything.
    var groups = [];
    var byKey = {};
    files.forEach(function (f, i) {
      var p = paths[i] || f.name;
      var key;
      if (isImg(p)) {
        var parts = String(p).replace(/^\/+/, '').split('/');
        key = 'img:' + (parts.length > 1 ? parts[0] : '');
      } else key = 'doc:' + i;
      if (!byKey[key]) {
        byKey[key] = { files: [], paths: [], folder: isImg(p) ? '' : parents[i], merge: key.indexOf('img:') === 0 ? key.slice(4) : '' };
        groups.push(byKey[key]);
      }
      byKey[key].files.push(f);
      byKey[key].paths.push(p);
    });

    var common = [];
    fd.forEach(function (v, k) { if (k !== 'files' && k !== 'filePaths' && k !== 'destDir') common.push([k, v]); });
    if (destDir) common.push(['destDir', destDir]);

    var stats = { totalFiles: 0, totalPages: 0, totalSize: 0, files: [] };
    var dirs = [];
    var errors = [];
    batch = { offset: 0, total: groups.length, active: true };
    var self = this;

    function sendGroup(i) {
      if (i >= groups.length) return Promise.resolve();
      batch.offset = i;
      var g = groups[i];
      var part = new FormData();
      common.forEach(function (kv) { part.append(kv[0], kv[1]); });
      g.files.forEach(function (f) { part.append('files', f); });
      part.append('filePaths', JSON.stringify(g.paths));
      var q = '?ci=' + (ciBox.checked ? '1' : '0') +
        '&folder=' + encodeURIComponent(g.folder || '') +
        '&merge=' + encodeURIComponent(g.merge || '') +
        '&dest=' + encodeURIComponent(destDir || '');
      return origFetch.call(self, '/convert' + q, { method: 'POST', body: part })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 200)); });
          return r.json();
        })
        .then(function (res) {
          var st = res.stats || {};
          stats.totalFiles += st.totalFiles || 0;
          stats.totalPages += st.totalPages || 0;
          stats.totalSize += st.totalSize || 0;
          stats.files = stats.files.concat(st.files || []);
          if (st.outputDir && dirs.indexOf(st.outputDir) < 0) dirs.push(st.outputDir);
        })
        .catch(function (e) { errors.push(g.paths[0] + ' : ' + e.message); })
        .then(function () { return sendGroup(i + 1); });
    }

    return sendGroup(0).then(function () {
      batch.active = false;
      if (!stats.totalFiles && errors.length) {
        return new Response('Aucun fichier converti. ' + errors.join(' | '), { status: 500 });
      }
      stats.outputDir = (dirs.length <= 3 ? dirs.join(' ; ') : dirs.length + ' dossiers') +
        (errors.length ? '  — ⚠️ ' + errors.length + ' échec(s) : ' + errors.join(' | ') : '');
      return new Response(JSON.stringify({ success: true, message: 'Conversion completed.', stats: stats }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };
})();

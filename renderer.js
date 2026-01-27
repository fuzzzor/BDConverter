// --- UI ---
// Hide progress thumbnail on load to avoid residual frame
// Simple i18n loader: English is default, optional French via YAML

let currentTranslations = {};

async function loadTranslations(lang = 'en') {
  // English relies on static HTML text
  if (lang !== 'fr') {
    currentTranslations = {};
    return;
  }

  try {
    const res = await fetch('i18n/fr.yml');
    const text = await res.text();

    // Minimal YAML parser supporting nested keys via indentation
    const lines = text.split(/\r?\n/);
    const dict = {};
    const stack = [];

    for (const rawLine of lines) {
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

      const indent = rawLine.match(/^ */)[0].length;
      const line = rawLine.trim();

      // Adjust stack based on indentation level (2 spaces per level)
      const level = Math.floor(indent / 2);
      stack.length = level;

      if (line.endsWith(':')) {
        // Section key
        stack[level] = line.replace(':', '').trim();
      } else {
        const m = line.match(/^([^:]+):\s*"?(.*?)"?$/);
        if (!m) continue;
        const key = m[1].trim();
        const value = m[2];
        const fullKey = [...stack.slice(0, level), key].join('.');
        dict[fullKey] = value;
      }
    }

    currentTranslations = dict;
    applyTranslations(currentTranslations);
  } catch (e) {
    console.error('Failed to load translations', e);
  }
}

function applyTranslations(dict) {
  // Text content
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    let value = dict[key];
    if (!value) return;
    const argsAttr = el.getAttribute('data-i18n-args');
    if (argsAttr) {
      try {
        const args = JSON.parse(argsAttr);
        Object.keys(args).forEach(k => {
          value = value.replace(`{${k}}`, args[k]);
        });
      } catch {}
    }
    el.textContent = value;
  });

  // Placeholder attributes (inputs)
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const value = dict[key];
    if (!value) return;
    el.setAttribute('placeholder', value);
  });

  // Tooltips (titles)
  const tooltipMap = {
    'dpi': 'tooltips.dpi',
    'colorMode': 'tooltips.color_mode',
    '.range-inputs': 'tooltips.page_range',
    'imgFormat': 'tooltips.image_format',
    'format': 'tooltips.archive_format',
    'archiveCompression': 'tooltips.archive_compression',
    'rotation': 'tooltips.rotation',
    '.compression-box': 'tooltips.quality'
  };

  Object.keys(tooltipMap).forEach(selector => {
      const key = tooltipMap[selector];
      const val = dict[key];
      if (val) {
          const els = selector.startsWith('.') ? document.querySelectorAll(selector) : [document.getElementById(selector)];
          els.forEach(el => { if(el) el.title = val; });
      }
  });
}

// Load French translations if browser language starts with 'fr'
document.addEventListener('DOMContentLoaded', () => {
  if (navigator.language && navigator.language.startsWith('fr')) {
    loadTranslations('fr');
  }
});
document.addEventListener('DOMContentLoaded', () => {
  const progressThumb = document.getElementById('progress-thumb');
  if (progressThumb) {
    progressThumb.style.display = 'none';
    progressThumb.innerHTML = '';
  }
});

const dropZone = document.getElementById('drop-zone');
const btnConvert = document.getElementById('btn-convert');
// Technical logs removed from the UI
const sliderCompression = document.getElementById('compression');
const lblCompression = document.getElementById('compression-val');
const progCurrentFill = document.getElementById('prog-current-fill');
const lblCurrentPct = document.getElementById('lbl-current-pct');
const progressThumb = document.getElementById('progress-thumb');

// Window counters
const countersContainer = document.getElementById('counters-container');
const pageCounterEl = document.getElementById('page-counter');
const fileCounterEl = document.getElementById('file-counter');

// End-of-process modal
const modal = document.getElementById('summary-modal');
const summaryDiv = document.getElementById('summary-details');
const btnCloseModal = document.getElementById('btn-close-modal');

// Hidden file input
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.accept = '.pdf,.cbz,.cbr,.cbt,.cb7,.zip,.rar,.tar,.7z';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

let selectedFiles = [];
let fileCounter = 0;
let totalFiles = 0;
let imageCounter = 0;
let totalImages = 0;
let globalTotalImages = 0; // Backup for Original mode cumulative view
let filesPageCounts = [];
let conversionStartTime = 0;

// Compression slider
sliderCompression.addEventListener('input', (e) => {
  lblCompression.innerText = e.target.value + '%';
});

// ✅ Original mode handling: disable image processing options
const dpiSelect = document.getElementById('dpi');
const colorModeSelect = document.getElementById('colorMode');
const imgFormatSelect = document.getElementById('imgFormat');
const compressionSlider = document.getElementById('compression');
const compressionBox = compressionSlider.closest('.control-group');
const originalHint = document.getElementById('original-hint');
const formatSelect = document.getElementById('format');
const archiveCompSelect = document.getElementById('archiveCompression');

function updateOriginalMode() {
  const isOriginal = dpiSelect.value === 'original';
  
  // Disable and gray out options not applicable in Original mode
  colorModeSelect.disabled = isOriginal;
  imgFormatSelect.disabled = isOriginal;
  compressionSlider.disabled = isOriginal;
  
  // Show or hide informational message
  if (originalHint) {
    originalHint.style.display = isOriginal ? 'block' : 'none';
  }
  
  // Update UI appearance to indicate disabled state
  if (isOriginal) {
    colorModeSelect.style.opacity = '0.5';
    imgFormatSelect.style.opacity = '0.5';
    compressionBox.style.opacity = '0.5';
    compressionSlider.style.cursor = 'not-allowed';
  } else {
    colorModeSelect.style.opacity = '1';
    imgFormatSelect.style.opacity = '1';
    compressionBox.style.opacity = '1';
    compressionSlider.style.cursor = 'pointer';
  }
  updateCompressionUI();
}

function updateCompressionUI() {
    const isOriginal = dpiSelect.value === 'original';
    const isCbt = formatSelect.value === 'cbt';
    const isPdf = formatSelect.value === 'pdf';
    
    // Archive compression
    if (isOriginal || isCbt || isPdf) {
        archiveCompSelect.disabled = true;
        archiveCompSelect.style.opacity = '0.5';
        archiveCompSelect.style.cursor = 'not-allowed';
    } else {
        archiveCompSelect.disabled = false;
        archiveCompSelect.style.opacity = '1';
        archiveCompSelect.style.cursor = 'pointer';
    }

    // Image format (disabled for PDF if requested, and obviously for Original)
    if (isOriginal || isPdf) {
        imgFormatSelect.disabled = true;
        imgFormatSelect.style.opacity = '0.5';
        // Force visual feedback for PDF
        if (isPdf && !isOriginal) {
            // Keep current value but grayed out, or maybe we don't care about value
        }
    } else {
        imgFormatSelect.disabled = false;
        imgFormatSelect.style.opacity = '1';
    }
}

// Listen for DPI selector changes
dpiSelect.addEventListener('change', updateOriginalMode);
formatSelect.addEventListener('change', updateCompressionUI);

// Initialize on load
updateOriginalMode();

// Technical logs removed

// Drag & Drop handling
dropZone.addEventListener('dragover', e => e.preventDefault());
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const allowedExtensions = ['.pdf', '.cbz', '.cbr', '.cbt', '.cb7', '.zip', '.rar', '.tar', '.7z'];
  const files = Array.from(fileList || []).filter(f => {
    if (!f.name) return false;
    const lower = f.name.toLowerCase();
    return allowedExtensions.some(ext => lower.endsWith(ext));
  });
  if (files.length === 0) return;

  const loadingStatus = document.getElementById('loading-status');
  if (loadingStatus) {
    loadingStatus.style.display = 'block';
    const tpl = currentTranslations['dropzone.analyzing'] || "Analyzing file {current} / {total}...";
    loadingStatus.innerText = tpl.replace('{current}', 0).replace('{total}', files.length);
  }

  selectedFiles = files;
  totalFiles = files.length;
  totalImages = 0;
  filesPageCounts = [];
  let totalSize = 0;
  let hasArchives = false;

  for (const [i, file] of files.entries()) {
    if (loadingStatus) {
      const tpl = currentTranslations['dropzone.analyzing'] || "Analyzing file {current} / {total}...";
      loadingStatus.innerText = tpl.replace('{current}', i + 1).replace('{total}', files.length);
    }
    totalSize += file.size;
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const buffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
        const pages = pdf.numPages;
        filesPageCounts.push(pages);
        totalImages += pages;
      } else if (file.name.match(/\.(cbz|zip)$/i)) {
        try {
          const zip = await JSZip.loadAsync(file);
          let count = 0;
          zip.forEach((relativePath, zipEntry) => {
             if (!zipEntry.dir && zipEntry.name.match(/\.(jpg|jpeg|png|gif|webp|tiff|bmp)$/i) && !zipEntry.name.startsWith('__MACOSX')) {
                 count++;
             }
          });
          if (count === 0) count = 1;
          filesPageCounts.push(count);
          totalImages += count;
        } catch(e) {
           console.warn('Zip analysis error', e);
           hasArchives = true;
           filesPageCounts.push(1);
           totalImages += 1;
        }
      } else {
        // Pour les autres archives (CBR, 7Z, TAR), on demande au serveur de les analyser
        try {
            const fd = new FormData();
            fd.append('file', file);
            // On envoie au serveur pour comptage (rapide en local)
            const res = await fetch('/analyze', { method: 'POST', body: fd });
            if (!res.ok) throw new Error('Analysis failed');
            const data = await res.json();
            const count = data.pages || 1;
            
            filesPageCounts.push(count);
            totalImages += count;
        } catch(e) {
            console.warn('Server analysis error', e);
            hasArchives = true; // Fallback d'affichage si l'analyse échoue
            filesPageCounts.push(1);
            totalImages += 1;
        }
      }
    } catch (e) {
      console.warn('Page count error', e);
      filesPageCounts.push(0);
    }
  }
  globalTotalImages = totalImages; // Save global total

  // Upload zone information (highlighted)
  let pagesHtml = '';
  if (hasArchives) {
      pagesHtml = `<div style="color:#FF9800;" data-i18n="dropzone.size_only" data-i18n-args='{"size":"${(totalSize / (1024 * 1024)).toFixed(2)}"}'>${(totalSize / (1024 * 1024)).toFixed(2)} MB</div>`;
  } else {
      pagesHtml = `<div style="color:#FF9800;" data-i18n="dropzone.pages" data-i18n-args='{"pages":${totalImages},"size":"${(totalSize / (1024 * 1024)).toFixed(2)}"}'>${totalImages} pages • ${(totalSize / (1024 * 1024)).toFixed(2)} MB</div>`;
  }

  dropZone.innerHTML = `
    <div style="color:#FF9800; font-weight:bold; font-size:1.1em;" data-i18n="dropzone.ready" data-i18n-args='{"count":${totalFiles}}'>${totalFiles} file(s) ready</div>
    ${pagesHtml}
    <div style="font-size:0.8em; color:#888; margin-top:4px;" data-i18n="dropzone.change">Click or drop to change</div>
    <div id="loading-status" style="display:none; color:#FF9800; margin-top:5px; font-size:0.9em;"></div>
  `;
  // Re-apply translations for dynamically injected HTML
  applyTranslations(currentTranslations);

  fileCounter = 0;
  imageCounter = 0;
  if (countersContainer) countersContainer.style.display = 'flex';
  if (pageCounterEl) pageCounterEl.innerText = `Page : 0 / ${totalImages}`;
  if (fileCounterEl) {
    const tpl = currentTranslations['progress.file'] || "File # {current} / {total}";
    fileCounterEl.innerText = tpl.replace('{current}', 0).replace('{total}', totalFiles);
  }

  btnConvert.disabled = false;
}

// --- CONVERSION PROCESS ---
btnConvert.addEventListener('click', async () => {
  if (!selectedFiles.length) return;

  // Immediate feedback
  btnConvert.disabled = true;
  const originalBtnText = btnConvert.innerText;
  btnConvert.innerText = currentTranslations['buttons.starting'] || "Starting...";
  
  conversionStartTime = Date.now();
  fileCounter = 0;
  imageCounter = 0;
  progressThumb.style.display = 'none';

  const requestId = generateUUID();
  const eventSource = new EventSource(`/events?requestId=${requestId}`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'thumbnail-init') {
      fileCounter += 1;
      imageCounter = 0;

      if (fileCounterEl) {
        const tpl = currentTranslations['progress.file'] || "File # {current} / {total}";
        fileCounterEl.innerText = tpl.replace('{current}', fileCounter).replace('{total}', totalFiles);
      }
      if (pageCounterEl) pageCounterEl.innerText = `Page : ${imageCounter} / ${totalImages}`;

      const isOriginal = document.getElementById('dpi')?.value === 'original';
      const initialWidth = isOriginal ? '100%' : '0%';

      progressThumb.innerHTML = `
        <div class="reveal-frame">
          <div class="color-reveal" style="width:${initialWidth}">
            <img src="${data.color}" />
          </div>
        </div>
      `;
      progressThumb.style.display = 'flex';
    }

    if (data.type === 'progress') {
      const isOriginal = document.getElementById('dpi')?.value === 'original';

      if (isOriginal) {
        // --- ORIGINAL MODE: Cumulative global progress ---
        // Restore global total if it was overwritten
        totalImages = globalTotalImages;

        const currentFileIdx = (data.currentFileIndex || 1) - 1;
        let previousPagesCount = 0;
        for (let i = 0; i < currentFileIdx; i++) {
          previousPagesCount += (filesPageCounts[i] || 0);
        }

        let currentFileConverted = 0;
        if (data.currentPct === 100) {
          currentFileConverted = filesPageCounts[currentFileIdx] || 0;
        }

        imageCounter = previousPagesCount + currentFileConverted;

      } else {
        // --- NORMAL MODE: Per-file progress (Legacy behavior) ---
        if (typeof data.totalPages === 'number') totalImages = data.totalPages;
        imageCounter = data.currentPages || 0;
      }

      // Update UI
      if (pageCounterEl) pageCounterEl.innerText = `Page : ${imageCounter} / ${totalImages}`;
      
      if (totalImages > 0) {
        const pct = Math.min(100, Math.max(0, (imageCounter / totalImages) * 100));
        
        // Fix: In Original mode, do not animate the thumbnail (keep it fully revealed as initialized)
        if (!isOriginal) {
            const reveal = progressThumb.querySelector('.color-reveal');
            if (reveal) reveal.style.width = pct + '%';
        }

        if (progCurrentFill) progCurrentFill.style.width = pct + '%';
        if (lblCurrentPct) lblCurrentPct.innerText = Math.round(pct) + '%';
      }

      // Update filename display based on current index
      const statusFileIdx = (data.currentFileIndex || 1) - 1;
      if (selectedFiles[statusFileIdx]) {
          const nameEl = document.getElementById('current-file-name');
          if (nameEl) nameEl.innerText = selectedFiles[statusFileIdx].name;
      }

      if (data.status) {
        const phaseLabel = document.getElementById('phase-label');
        if (phaseLabel) {
          const lower = data.status.toLowerCase();
          let statusText = data.status;

          // Translate known statuses
          if (lower.includes('analyzing') || lower.includes('analyse')) {
              statusText = currentTranslations['progress.processing'] || "Processing...";
          } else if (lower.includes('assembling') || lower.includes('assemblage')) {
              statusText = currentTranslations['progress.assembling'] || "Assembling...";
          }
          
          phaseLabel.innerText = statusText;
        }
      }

      if (data.currentPct === 100 && typeof data.currentFileIndex === 'number' && typeof data.totalFiles === 'number') {
        fileCounter = data.currentFileIndex;
        if (fileCounterEl) {
            const tpl = currentTranslations['progress.file'] || "File # {current} / {total}";
            fileCounterEl.innerText = tpl.replace('{current}', fileCounter).replace('{total}', data.totalFiles);
        }
      }
    }
  };

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('files', f));
  formData.append('requestId', requestId);
  
  // ✅ CRITICAL FIX: send ALL parameters to the server
  formData.append('dpi', document.getElementById('dpi').value);
  formData.append('colorMode', document.getElementById('colorMode').value);
  formData.append('pageStart', document.getElementById('pageStart').value);
  formData.append('pageEnd', document.getElementById('pageEnd').value);
  formData.append('format', document.getElementById('format').value);
  formData.append('compression', document.getElementById('compression').value);
  formData.append('archiveCompression', document.getElementById('archiveCompression').value);
  formData.append('rotation', document.getElementById('rotation').value);
  formData.append('imgFormat', document.getElementById('imgFormat').value);

  try {
    const response = await fetch('/convert', { method: 'POST', body: formData });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server Error (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    showSummary(result.stats);
  } catch (e) {
    console.error(e);
    alert(`Error: ${e.message}`);
    btnConvert.disabled = false;
    btnConvert.innerText = originalBtnText;
  } finally {
    eventSource.close();
  }
});

btnCloseModal.addEventListener('click', () => {
  modal.style.display = 'none';
  resetUI();
});

// Allow resetting UI by clicking the app icon
const appIcon = document.querySelector('.app-icon');
if (appIcon) {
  appIcon.addEventListener('click', () => {
    resetControls();
    resetUI();
  });
}

// Display conversion summary modal
function showSummary(stats) {
  const sizeMB = (stats.totalSize / (1024 * 1024)).toFixed(2);
  const durationSec = conversionStartTime ? Math.round((Date.now() - conversionStartTime) / 1000) : 0;
  const durationStr = durationSec < 60
    ? `${durationSec} s`
    : `${Math.floor(durationSec / 60)} min ${durationSec % 60} s`;

  let thumbs = '<div style="display:flex; flex-wrap:wrap; gap:10px; justify-content:center; max-height:220px; overflow:auto;">';
  if (Array.isArray(stats.files)) {
    for (const f of stats.files) {
      if (f.thumbnail) {
        thumbs += `
          <div style="width:100px; text-align:center;">
            <img src="${f.thumbnail}" style="width:100%; border-radius:6px; border:1px solid #444;" />
            <div style="font-size:0.7em; color:#ccc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${f.name}</div>
          </div>`;
      }
    }
  }
  thumbs += '</div>';

  summaryDiv.innerHTML = `
    <div class="summary-stats">
      <div class="stat-row"><span class="stat-label" style="color:#FF9800">Fichiers convertis :</span><span class="stat-value" style="color:#FF9800">${stats.totalFiles}</span></div>
      <div class="stat-row"><span class="stat-label" style="color:#FF9800">Pages totales :</span><span class="stat-value" style="color:#FF9800">${stats.totalPages}</span></div>
      <div class="stat-row"><span class="stat-label" style="color:#FF9800">Temps écoulé :</span><span class="stat-value" style="color:#FF9800">${durationStr}</span></div>
      <div class="stat-row"><span class="stat-label" style="color:#FF9800">Taille totale :</span><span class="stat-value" style="color:#FF9800">${sizeMB} MB</span></div>
      <div class="stat-row"><span class="stat-label">Dossier de sortie :</span><span class="stat-value">${stats.outputDir}</span></div>
    </div>
    ${thumbs}
  `;
  applyTranslations(currentTranslations);

  modal.style.display = 'flex';
}

// Reset all control gadgets to default
function resetControls() {
    dpiSelect.value = 'original';
    colorModeSelect.value = 'jpeg';
    document.getElementById('pageStart').value = '';
    document.getElementById('pageEnd').value = '';
    imgFormatSelect.value = 'jpeg';
    formatSelect.value = 'cbz';
    archiveCompSelect.value = '5';
    document.getElementById('rotation').value = '0';
    compressionSlider.value = 80;
    lblCompression.innerText = '80%';
    
    // Trigger change events to update UI state (grayed out elements etc)
    updateOriginalMode();
}

// Reset UI to initial state (files and progress only)
function resetUI() {
  selectedFiles = [];
  filesPageCounts = [];
  fileCounter = 0;
  totalFiles = 0;
  imageCounter = 0;
  totalImages = 0;
  globalTotalImages = 0;

  dropZone.innerHTML = `
    <div style="color: #666; font-size: 0.85em; margin-bottom: 12px; font-weight: 500;">
        <span data-i18n="dropzone.formats">Accepted formats:</span> PDF, CBZ, CBR, CBT, CB7, ZIP, RAR, TAR, 7Z
    </div>
    <div class="icon">📂</div>
    <div style="font-size: 1.1em; font-weight: bold;" data-i18n="dropzone.title">Drag & drop your files here</div>
    <p data-i18n="dropzone.browse">(or click to browse)</p>
    <div id="loading-status" style="display:none; color:#FF9800; margin-top:5px; font-size:0.9em;"></div>
  `;
  applyTranslations(currentTranslations);

  // Reset button text in case it was stuck on "Starting..."
  btnConvert.innerText = currentTranslations['buttons.convert'] || "Convert file(s)";

  if (pageCounterEl) pageCounterEl.innerText = 'Page : 0 / 0';
  if (fileCounterEl) {
      const tpl = currentTranslations['progress.file'] || "File # {current} / {total}";
      fileCounterEl.innerText = tpl.replace('{current}', 0).replace('{total}', 0);
  }
  if (countersContainer) countersContainer.style.display = 'none';

  progressThumb.innerHTML = '';
  progressThumb.style.display = 'none';

  btnConvert.disabled = true;

  const phaseLabel = document.getElementById('phase-label');
  if (phaseLabel) phaseLabel.innerText = '';
  
  const nameEl = document.getElementById('current-file-name');
  if (nameEl) nameEl.innerText = '';
}

// Generate a UUID (compatible with older browsers)
function generateUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
// ComicInfo.xml generation
// ------------------------
// Adds a ComicInfo.xml (series, number, title, year) at the root of the generated
// archives, so that readers/servers such as Kavita, Komga or Komf group the albums of a series
// correctly instead of guessing from the file name.
//
// The information is deduced from the file name, and from its folder when the file name
// does not contain the series name:
//   "Astérix - T02 - La serpe d'or (1962)"  -> Series "Astérix", Number 2, Title "La serpe d'or", Year 1962
//   "Achille Talon - INT01"                 -> Series "Achille Talon", Number 1
//   "XIII Vol. 03"                          -> Series "XIII", Number 3
//   "HardLand/01-Le sanglier"               -> Series "HardLand" (folder), Number 1, Title "Le sanglier"
//   "Metal Hurlant 042"                     -> Series "Metal Hurlant", Number 42
//   "Shutter island (2008)"                 -> one-shot: Series "Shutter island", Year 2008
const fs = require('fs');
const path = require('path');

// Volume markers: T02, T.2, Tome 2, Vol. 3, Volume 3, INT01, Intégrale 1, N001, n°4, #4
const MARKER = '(tome|t|vol(?:ume)?|int(?:[ée]grale)?|n°|no|n|#)';
const NUM = '(\\d{1,4}(?:[.,]\\d+)?)';

const clean = (s) => String(s || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:.,]+|[\s\-–—:,]+$/g, '')
    .trim();

const toNumber = (s) => String(Number(String(s).replace(',', '.')));
const isIntegrale = (marker) => /^int/i.test(marker || '');

/**
 * Deduce series information from a file path (relative path as dropped, or a plain file name).
 * Rules aligned with the kavita_all.py library script:
 *  - "Series - T02 - Title"        -> Series, Number 2, Title
 *  - "Series - INT01"              -> "Series - Intégrales", Number 1 (kept apart from the albums)
 *  - "Series - HS - Title"         -> "Series - Hors-série", Title
 *  - "Folder/01-Title"             -> Series = folder, Number 1, Title
 *  - one-shot "Title (2008)"       -> Series = Title = "Title", Year 2008
 *  - other parentheses are kept: "Agatha Christie (Emmanuel Proust Éditions) - 16"
 * @returns {{series: string, number: (string|null), title: (string|null), year: (string|null)}}
 */
function parseComicName(filePath) {
    const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const base = parts[parts.length - 1] || '';
    const em = base.match(/\.[a-z0-9]{1,5}$/i); // "XIII Vol. 03" has no extension
    let name = em ? base.slice(0, -em[0].length) : base;
    const folder = parts.length > 1 ? clean(parts[parts.length - 2]) : '';

    // Year "(1962)", "[1962]" or date "(1975-01)"
    let year = null;
    const y = name.match(/[(\[]\s*((?:19|20)\d{2})(?:-\d{2})?\s*[)\]]/);
    if (y) {
        year = y[1];
        name = name.replace(y[0], ' ');
    }
    name = clean(name);

    let m;
    // 1. "Series - T02 - Title", "Series T02", "Series Vol. 3 : Title", "Series - INT01", "Series - N001"
    // ("bis" = .5: "N033bis" -> 33.5; a parenthesis right after the number is ignored: "T01 (Author)")
    m = name.match(new RegExp(`^(.*?)(?:^|[\\s\\-–—,]+)${MARKER}\\.?\\s*${NUM}(bis)?\\b\\s*(?:\\([^)]*\\))?\\s*(?:[\\-–—:.]\\s*(.*))?$`, 'i'));
    if (m && (clean(m[1]) || folder)) {
        let series = clean(m[1]) || folder;
        if (isIntegrale(m[2])) series += ' - Intégrales';
        const number = m[4] ? String(Number(toNumber(m[3])) + 0.5) : toNumber(m[3]);
        return { series, number, title: clean(m[5]) || null, year };
    }

    // 2. "Series - INT" (single integral, no number)
    m = name.match(/^(.*?)[\s\-–—,]+int(?:[ée]grale)?\b\s*(?:\([^)]*\))?\s*(?:[\-–—:.]\s*(.*))?$/i);
    if (m && clean(m[1])) {
        return { series: clean(m[1]) + ' - Intégrales', number: '1', title: clean(m[2]) || null, year };
    }

    // 3. "Series - HS - Title" (hors-série)
    m = name.match(/^(.*?)[\s\-–—,]+(?:HS|hors[\s\-]?s[ée]rie)\b\s*(?:\d+)?\s*(?:[\-–—:.]\s*(.*))?$/i);
    if (m && clean(m[1])) {
        return { series: clean(m[1]) + ' - Hors-série', number: null, title: clean(m[2]) || null, year };
    }

    // 4. "Series - 3 - Title"
    m = name.match(/^(.*?\D)\s+[\-–—]\s+(\d{1,4})\s+[\-–—]\s+(.+)$/);
    if (m && clean(m[1])) {
        return { series: clean(m[1]), number: toNumber(m[2]), title: clean(m[3]) || null, year };
    }

    // 5. "01-Title", "01 - Title" (series = folder; 4 digits would rather be a year: "1984 - Nesti")
    m = name.match(/^(\d{1,3})\s*[\-–—._]\s*(.+)$/);
    if (m && folder) {
        return { series: folder, number: toNumber(m[1]), title: clean(m[2]) || null, year };
    }

    // 6. "Series 042", "Series - 42"
    m = name.match(/^(.*?\D)[\s\-–—]+(\d{1,3})$/);
    if (m && clean(m[1])) {
        return { series: clean(m[1]), number: toNumber(m[2]), title: null, year };
    }

    // 7. Just a number: "042" (series = folder)
    m = name.match(/^(\d{1,4})$/);
    if (m && folder) {
        return { series: folder, number: toNumber(m[1]), title: null, year };
    }

    // 8. One-shot: the name is the series and the title
    const title = name || folder || 'Unknown';
    return { series: title, number: null, title, year };
}

const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// Same layout as the kavita_all.py library script (known to work with Kavita)
const LANGUAGE = process.env.COMICINFO_LANGUAGE || 'fr';

function buildComicInfoXml(info) {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>',
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'];
    const add = (tag, value) => {
        if (value !== null && value !== undefined && value !== '') lines.push(`  <${tag}>${escapeXml(value)}</${tag}>`);
    };
    add('Title', info.title);
    add('Series', info.series);
    add('Number', info.number);
    add('Volume', info.number);
    add('Year', info.year);
    add('LanguageISO', LANGUAGE);
    add('Manga', 'No');
    lines.push('</ComicInfo>', '');
    return lines.join('\n');
}

/**
 * Write ComicInfo.xml in the folder that is about to be archived.
 * @param {string} dir      folder containing the pages
 * @param {string} source   original relative path (used to deduce the series)
 * @returns {object|null}   the information written, or null
 */
function writeComicInfo(dir, source) {
    const target = path.join(dir, 'ComicInfo.xml');
    if (fs.existsSync(target)) return null; // keep an existing one
    const info = parseComicName(source);
    fs.writeFileSync(target, buildComicInfoXml(info), 'utf8');
    return info;
}

module.exports = { parseComicName, buildComicInfoXml, writeComicInfo };

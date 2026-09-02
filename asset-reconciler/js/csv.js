/* CSV read/write. RFC 4180 with the practical extensions the real exports
   need: BOM, CRLF, quoted newlines, and delimiter sniffing (Excel on a UK
   machine will happily hand you semicolons or tabs). */
(function (global) {
  'use strict';

  function sniffDelimiter(text) {
    var sample = text.slice(0, 64 * 1024);
    var candidates = [',', ';', '\t', '|'];
    var best = ',', bestScore = -1;

    candidates.forEach(function (d) {
      var counts = [];
      var inQ = false, n = 0, lines = 0;
      for (var i = 0; i < sample.length && lines < 30; i++) {
        var c = sample[i];
        if (c === '"') {
          if (inQ && sample[i + 1] === '"') { i++; continue; }
          inQ = !inQ;
        } else if (!inQ && c === d) n++;
        else if (!inQ && c === '\n') { counts.push(n); n = 0; lines++; }
      }
      if (n > 0 || counts.length === 0) counts.push(n);
      var nonEmpty = counts.filter(function (x) { return x > 0; });
      if (!nonEmpty.length) return;
      // Prefer the delimiter with the highest, most consistent field count.
      var first = nonEmpty[0];
      var consistent = nonEmpty.filter(function (x) { return x === first; }).length / nonEmpty.length;
      var score = first * (0.4 + 0.6 * consistent);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  /* Synthetic per-row key holding the first column's indent depth. */
  var INDENT = '__indent';

  function indentOf(v) {
    var s = v === undefined || v === null ? '' : String(v);
    var n = 0;
    while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n += s[n] === '\t' ? 4 : 1;
    return n;
  }

  function parse(text, opts) {
    opts = opts || {};
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);       // strip BOM
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    var delim = opts.delimiter || sniffDelimiter(text);
    var rows = [];
    var row = [];
    var field = '';
    var inQ = false;
    var started = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
        continue;
      }
      if (c === '"' && !started) { inQ = true; started = true; continue; }
      if (c === delim) { row.push(field); field = ''; started = false; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; continue; }
      field += c;
      started = true;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    // Drop wholly-blank lines (trailing newline, spacer rows).
    rows = rows.filter(function (r) {
      return r.some(function (v) { return String(v).trim() !== ''; });
    });
    if (!rows.length) return { headers: [], rows: [], delimiter: delim };

    // Some Freshservice/Intune exports carry a title or filter line above the
    // real header. Take the first row with the most non-empty cells within the
    // first five rows as the header.
    var headerIdx = 0, bestCount = 0;
    for (var h = 0; h < Math.min(5, rows.length); h++) {
      var cnt = rows[h].filter(function (v) { return String(v).trim() !== ''; }).length;
      if (cnt > bestCount) { bestCount = cnt; headerIdx = h; }
    }

    var headers = rows[headerIdx].map(function (v, idx) {
      var name = String(v).trim();
      return name || ('Column ' + (idx + 1));
    });
    // De-duplicate repeated header names.
    var seen = {};
    headers = headers.map(function (nm) {
      if (seen[nm] === undefined) { seen[nm] = 0; return nm; }
      seen[nm]++;
      return nm + ' (' + seen[nm] + ')';
    });

    var out = [];
    for (var r2 = headerIdx + 1; r2 < rows.length; r2++) {
      var raw = rows[r2];
      var obj = {};
      for (var c2 = 0; c2 < headers.length; c2++) {
        obj[headers[c2]] = raw[c2] === undefined ? '' : String(raw[c2]).trim();
      }
      // FortiManager encodes the device tree as leading spaces in the first
      // column, so the depth has to be read before the trim above throws it
      // away. Kept off the header list: it is not a column anyone can map.
      obj[INDENT] = indentOf(raw[0]);
      out.push(obj);
    }
    return { headers: headers, rows: out, delimiter: delim };
  }

  function cell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      return String(v.getDate()).padStart(2, '0') + '/' +
             String(v.getMonth() + 1).padStart(2, '0') + '/' + v.getFullYear();
    }
    var s = String(v);
    // Guard against spreadsheet formula injection in exported files.
    if (/^[=+\-@\t]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function stringify(rows, headers) {
    if (!rows || !rows.length) return (headers || []).join(',') + '\n';
    headers = headers || Object.keys(rows[0]);
    var lines = [headers.map(cell).join(',')];
    rows.forEach(function (r) {
      lines.push(headers.map(function (h) { return cell(r[h]); }).join(','));
    });
    return lines.join('\n') + '\n';
  }

  /* Read a File object. .xlsx/.xls are handed to SheetJS, lazy-loaded from a
     CDN only when one actually turns up; everything else is read as text. */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var name = (file.name || '').toLowerCase();
      if (/\.(xlsx|xlsm|xls)$/.test(name)) {
        loadSheetJs().then(function (XLSX) {
          var fr = new FileReader();
          fr.onerror = function () { reject(new Error('Could not read ' + file.name)); };
          fr.onload = function () {
            try {
              var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellDates: true });
              var sheet = wb.Sheets[wb.SheetNames[0]];
              var csv = XLSX.utils.sheet_to_csv(sheet);
              resolve(parse(csv));
            } catch (e) { reject(e); }
          };
          fr.readAsArrayBuffer(file);
        }).catch(reject);
        return;
      }
      var fr2 = new FileReader();
      fr2.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      fr2.onload = function () {
        try { resolve(parse(String(fr2.result))); }
        catch (e) { reject(e); }
      };
      fr2.readAsText(file, 'utf-8');
    });
  }

  var sheetJsPromise = null;
  function loadSheetJs() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (sheetJsPromise) return sheetJsPromise;
    sheetJsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = function () {
        if (global.XLSX) resolve(global.XLSX);
        else reject(new Error('Spreadsheet reader failed to initialise'));
      };
      s.onerror = function () {
        reject(new Error('Could not load the .xlsx reader (no internet?). Save the file as CSV and try again.'));
      };
      document.head.appendChild(s);
    });
    return sheetJsPromise;
  }

  global.CSV = {
    INDENT: INDENT,
    parse: parse,
    stringify: stringify,
    readFile: readFile,
    sniffDelimiter: sniffDelimiter,
    cell: cell
  };
})(window);

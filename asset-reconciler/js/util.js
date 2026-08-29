/* Small DOM + formatting helpers. No dependencies. */
(function (global) {
  'use strict';

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (Array.isArray(children) ? children : children === undefined || children === null ? [] : [children])
      .forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        n.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
      });
    return n;
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  /* Emptying a container by repeated removeChild can throw when a re-render is
     triggered from a handler on a child that is being removed (the focused
     input's blur, typically) and the two passes interleave. replaceChildren
     empties in one step and cannot get into that state. */
  function clear(node) {
    if (!node) return node;
    if (node.replaceChildren) node.replaceChildren();
    else node.textContent = '';
    return node;
  }

  /* ---------------------------------------------------------- formatting */

  function num(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-GB');
  }

  function pct(n, d) {
    if (!d) return '—';
    return Math.round((n / d) * 100) + '%';
  }

  /* Parse the date formats that turn up in Freshservice / Intune exports.
     Returns a Date or null. Ambiguous all-numeric dates are read as
     day-first (UK), which is what both portals emit for a UK tenant. */
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var s = String(v).trim();
    if (!s || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'never') return null;

    // ISO-ish: 2026-03-14, 2026-03-14T09:12:00Z
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)));
    }

    // d/m/Y or d-m-Y (with optional time)
    var dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
    if (dmy) {
      var d = +dmy[1], mo = +dmy[2], y = +dmy[3];
      if (y < 100) y += 2000;
      // If the first field can't be a day but the second can, it was m/d/Y.
      if (d > 12 && mo <= 12) { /* day-first, as read */ }
      else if (mo > 12 && d <= 12) { var t = d; d = mo; mo = t; }
      var hh = +(dmy[4] || 0);
      if (dmy[7]) {
        var ap = dmy[7].toLowerCase();
        if (ap === 'pm' && hh < 12) hh += 12;
        if (ap === 'am' && hh === 12) hh = 0;
      }
      var dt = new Date(Date.UTC(y, mo - 1, d, hh, +(dmy[5] || 0), +(dmy[6] || 0)));
      return isNaN(dt.getTime()) ? null : dt;
    }

    // "14 Mar 2026", "Mar 14, 2026"
    var nat = Date.parse(s);
    if (!isNaN(nat)) return new Date(nat);
    return null;
  }

  function fmtDate(v) {
    var d = v instanceof Date ? v : parseDate(v);
    if (!d) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function daysSince(v) {
    var d = v instanceof Date ? v : parseDate(v);
    if (!d) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function ageLabel(v) {
    var n = daysSince(v);
    if (n === null) return '—';
    if (n < 0) return 'in ' + Math.abs(n) + 'd';
    if (n === 0) return 'today';
    if (n === 1) return '1 day';
    if (n < 60) return n + ' days';
    return Math.round(n / 30.4) + ' months';
  }

  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function truncate(s, n) {
    s = String(s === null || s === undefined ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------- browser */

  /* A UTF-8 BOM makes Excel open the file with the right encoding, so it is on
     by default for anything a person will read. Pass bom:false for files a
     machine parses - some importers show the BOM as part of the first column
     name. */
  function download(filename, content, mime, opts) {
    var useBom = !(opts && opts.bom === false);
    var body = useBom ? '﻿' + content : content;
    var blob = content instanceof Blob ? content : new Blob([body], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }

  var toastHost = null;
  function toast(msg, kind, ms) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toasts' });
      document.body.appendChild(toastHost);
    }
    var t = el('div', { class: 'toast ' + (kind || ''), text: msg });
    toastHost.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s'; t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, ms || 3800);
  }

  var tipEl = null;
  function tooltip(html, x, y) {
    if (!tipEl) { tipEl = el('div', { class: 'tooltip' }); document.body.appendChild(tipEl); }
    if (html === null) { tipEl.classList.remove('show'); return; }
    tipEl.innerHTML = html;
    tipEl.classList.add('show');
    var r = tipEl.getBoundingClientRect();
    var left = Math.min(x + 14, window.innerWidth - r.width - 8);
    var top = Math.max(8, y - r.height - 12);
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }

  function sortBy(arr, keyFn, dir) {
    var d = dir === 'desc' ? -1 : 1;
    return arr.slice().sort(function (a, b) {
      var x = keyFn(a), y = keyFn(b);
      var xe = x === null || x === undefined || x === '';
      var ye = y === null || y === undefined || y === '';
      if (xe && ye) return 0;
      if (xe) return 1;          // blanks always sort last
      if (ye) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * d;
      if (x instanceof Date && y instanceof Date) return (x - y) * d;
      return String(x).localeCompare(String(y), 'en-GB', { numeric: true, sensitivity: 'base' }) * d;
    });
  }

  function groupBy(arr, keyFn) {
    var m = new Map();
    arr.forEach(function (item) {
      var k = keyFn(item);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    });
    return m;
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  global.U = {
    el: el, qs: qs, qsa: qsa, clear: clear,
    num: num, pct: pct, parseDate: parseDate, fmtDate: fmtDate,
    daysSince: daysSince, ageLabel: ageLabel, todayStamp: todayStamp,
    truncate: truncate, escapeHtml: escapeHtml,
    download: download, toast: toast, tooltip: tooltip, debounce: debounce,
    sortBy: sortBy, groupBy: groupBy, uniq: uniq
  };
})(window);

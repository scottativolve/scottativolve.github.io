/* The published data set: one file next to the HTML that everybody opening the
   tool starts from.

   The obvious shape for this would be published-data.json read with fetch().
   It cannot be, and the reason is worth writing down so nobody tries it again:
   Chrome treats a page opened from file:// as having no origin at all, so it
   refuses to let that page read a file sitting in its own folder. fetch() and
   XMLHttpRequest both fail on CORS grounds. There is a browser flag that turns
   the restriction off, but it weakens every local page the machine ever opens
   and would have to be pushed to everybody's shortcut.

   A <script src> is not subject to CORS. So the published file is JavaScript
   that assigns one global, which loads from a folder, a synced SharePoint
   library or a USB stick with no server, no flags and no prompts. Served over
   HTTP it works just the same. */
(function (global) {
  'use strict';

  var FILE = 'published-data.js';
  var GLOBAL_NAME = 'PublishedData';

  var state = { tried: false, payload: null, error: '' };

  /* Read the published file if there is one. Never rejects: not having a
     published set is the normal case for somebody running the tool on their
     own, and it must not look like a fault. */
  function load() {
    if (state.tried) return Promise.resolve(state.payload);
    state.tried = true;

    if (global[GLOBAL_NAME]) {           // already present, however it got here
      state.payload = validate(global[GLOBAL_NAME]);
      return Promise.resolve(state.payload);
    }
    if (typeof document === 'undefined') return Promise.resolve(null);

    return new Promise(function (resolve) {
      var s = document.createElement('script');
      /* Cache-busted deliberately. The entire point of the file is that a
         colleague opening the tool sees the current set, and a browser serving
         a cached copy of last week's would defeat it silently. It is read from
         a local folder in the normal case, so re-reading costs nothing. */
      s.src = FILE + '?t=' + Date.now();
      s.async = true;
      s.onload = function () {
        state.payload = validate(global[GLOBAL_NAME]);
        if (!state.payload) state.error = FILE + ' loaded but did not set window.' + GLOBAL_NAME;
        resolve(state.payload);
      };
      s.onerror = function () {
        /* No file, or no permission to read it. Both mean "nothing
           published", which is the normal case for somebody running the tool
           on their own, so it resolves quietly.

           The browser still logs one ERR_FILE_NOT_FOUND (or a 404 over HTTP)
           to the console, and there is no way to stop it: a script tag that
           misses always says so. It is expected, nothing is broken by it, and
           it is the price of being able to read a neighbouring file from a
           file:// page at all. */
        state.error = '';
        resolve(null);
      };
      document.head.appendChild(s);
    });
  }

  function validate(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.format !== 'asset-reconciler-project') return null;
    if (!p.sources || !Object.keys(p.sources).length) return null;
    return p;
  }

  function payload() { return state.payload; }
  function problem() { return state.error; }

  /* When the published set was made, as a Date, or null. */
  function publishedAt(p) {
    p = p || state.payload;
    if (!p || !p.savedAt) return null;
    var d = new Date(p.savedAt);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Newer than what this browser already holds? Equal timestamps count as not
     newer, so re-opening the tool does not keep offering the same set. */
  function isNewerThan(p, when) {
    var a = publishedAt(p);
    if (!a) return false;
    if (!when) return true;
    return a.getTime() > new Date(when).getTime();
  }

  /* How many rows of what, for the banner. */
  function summarise(p) {
    p = p || state.payload;
    if (!p || !p.sources) return '';
    var bits = [];
    Object.keys(p.sources).forEach(function (id) {
      var src = p.sources[id];
      var n = src && src.raw ? src.raw.length : 0;
      if (!n) return;
      var def = (global.Schema && global.Schema.SOURCES[id]) || null;
      bits.push((def ? def.short : id) + ' ' + global.U.num(n));
    });
    return bits.join(', ');
  }

  /* The file to hand to whoever maintains the share.

     Two escapes matter. "</script" would end the tag early if anybody ever
     pasted this inline rather than referencing it, and U+2028/U+2029 are legal
     inside a JSON string but were illegal in a JavaScript string literal until
     ES2019 — a stray one from a copy-pasted address would be a syntax error
     that points at nothing. */
  function wrap(p) {
    var json = JSON.stringify(p)
      .replace(/<\//g, '<\\/')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    var when = p && p.savedAt ? new Date(p.savedAt).toLocaleString('en-GB') : 'unknown';
    return '/* Asset Reconciler — published data set.\n' +
           '   Published ' + when + (p && p.savedBy ? ' by ' + p.savedBy : '') + '.\n' +
           '   Keep this file in the same folder as asset-reconciler.html. It is read\n' +
           '   by a script tag rather than fetched, because a page opened from file://\n' +
           '   is not allowed to read its own folder any other way.\n' +
           '   Contains device and staff data. Treat it accordingly. */\n' +
           'window.' + GLOBAL_NAME + ' = ' + json + ';\n';
  }

  global.Published = {
    FILE: FILE,
    GLOBAL_NAME: GLOBAL_NAME,
    load: load,
    payload: payload,
    problem: problem,
    publishedAt: publishedAt,
    isNewerThan: isNewerThan,
    summarise: summarise,
    wrap: wrap
  };
})(window);

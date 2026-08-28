/* Local persistence.

   Only configuration is kept in localStorage - column mappings, thresholds,
   saved views, the geocode cache and the Freshservice header names. Device
   data is never written to disk by the tool; it lives in memory for the life
   of the tab. "Save project" is the deliberate, user-initiated exception and
   writes to a file the user chooses. */
(function (global) {
  'use strict';

  var PREFIX = 'assetrecon.v1.';
  var memory = {};                    // fallback when storage is unavailable

  function available() {
    try {
      var k = PREFIX + '__t';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  var HAS_LS = available();

  function get(key, fallback) {
    try {
      var raw = HAS_LS ? localStorage.getItem(PREFIX + key) : memory[key];
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function set(key, value) {
    try {
      var raw = JSON.stringify(value);
      if (HAS_LS) localStorage.setItem(PREFIX + key, raw);
      else memory[key] = raw;
      return true;
    } catch (e) {
      // Quota exceeded, private mode, or a storage-blocking policy: degrade
      // to in-memory rather than breaking the session.
      try { memory[key] = JSON.stringify(value); } catch (e2) {}
      return false;
    }
  }

  function remove(key) {
    try { if (HAS_LS) localStorage.removeItem(PREFIX + key); } catch (e) {}
    delete memory[key];
  }

  /* Column mappings are remembered per set of headers, so re-importing next
     month's export of the same shape needs no re-mapping. */
  function headerSignature(sourceId, headers) {
    var s = sourceId + '|' + headers.slice().sort().join('~');
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'map.' + sourceId + '.' + h.toString(36);
  }

  function getMapping(sourceId, headers) { return get(headerSignature(sourceId, headers), null); }
  function saveMapping(sourceId, headers, mapping) { set(headerSignature(sourceId, headers), mapping); }

  function clearAll() {
    if (HAS_LS) {
      Object.keys(localStorage).filter(function (k) { return k.indexOf(PREFIX) === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    }
    memory = {};
  }

  global.Store = {
    get: get, set: set, remove: remove,
    getMapping: getMapping, saveMapping: saveMapping,
    clearAll: clearAll, persistent: HAS_LS
  };
})(window);

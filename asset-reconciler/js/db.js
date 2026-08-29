/* Persists the working set - the files you have loaded - between visits.

   localStorage is the wrong home for this: it is synchronous, capped at a few
   megabytes, and a thousand-device estate across four source files will exceed
   that. IndexedDB is asynchronous, handles far more, and stores structured
   data without a JSON round trip.

   This holds real device and user data, so it is a visible, reversible choice
   rather than a silent one: the switch lives in Settings, the Data tab says
   when the working set was last saved, and clearing it is one button. */
(function (global) {
  'use strict';

  var DB_NAME = 'assetrecon';
  var STORE = 'workingset';
  var KEY = 'current';
  var VERSION = 1;

  var available = (function () {
    try { return !!global.indexedDB; } catch (e) { return false; }
  })();

  function open() {
    return new Promise(function (resolve, reject) {
      if (!available) { reject(new Error('This browser has no IndexedDB')); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open local storage')); };
      req.onblocked = function () { reject(new Error('Local storage is busy in another tab')); };
    });
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var req;
        try { req = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        t.onerror = function () { db.close(); reject(t.error); };
        t.onabort = function () { db.close(); reject(t.error || new Error('Storage transaction aborted')); };
      });
    });
  }

  function save(payload) {
    return tx('readwrite', function (store) { return store.put(payload, KEY); })
      .catch(function (err) {
        // Quota, private browsing, or a policy blocking site data: report it
        // rather than let the user believe the work is safe.
        var e = new Error(
          /quota/i.test((err && err.name) || '')
            ? 'There is not enough room in this browser to store the data.'
            : 'Could not save to this browser: ' + ((err && err.message) || 'unknown error')
        );
        e.cause = err;
        throw e;
      });
  }

  function load() {
    return tx('readonly', function (store) { return store.get(KEY); })
      .catch(function () { return null; });
  }

  function clear() {
    return tx('readwrite', function (store) { return store.delete(KEY); })
      .catch(function () { return null; });
  }

  function estimate() {
    if (!global.navigator || !navigator.storage || !navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    return navigator.storage.estimate()
      .then(function (e) { return e && e.usage ? e.usage : null; })
      .catch(function () { return null; });
  }

  global.DB = {
    available: available,
    save: save, load: load, clear: clear, estimate: estimate
  };
})(window);

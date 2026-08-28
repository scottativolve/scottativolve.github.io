/* Optional geocoding for the location lookup.

   Preferred path is postcodes.io - a free UK postcode service with a bulk
   endpoint and no key, which covers almost every site in a UK estate. Free-text
   addresses fall back to OpenStreetMap's Nominatim, throttled to one request a
   second in line with its usage policy.

   Results are cached in localStorage, and the lookup can be exported with the
   coordinates filled in so this only ever needs doing once. */
(function (global) {
  'use strict';

  var CACHE_KEY = 'geocache';
  var cache = global.Store.get(CACHE_KEY, {});

  function cacheKey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  function fromCache(s) {
    var v = cache[cacheKey(s)];
    return v && typeof v.lat === 'number' ? v : null;
  }

  function toCache(s, lat, lon, src) {
    cache[cacheKey(s)] = { lat: lat, lon: lon, src: src };
    global.Store.set(CACHE_KEY, cache);
  }

  function normalisePostcode(p) {
    var s = String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 5 || s.length > 7) return null;
    return s.slice(0, s.length - 3) + ' ' + s.slice(s.length - 3);
  }

  function looksLikePostcode(p) { return !!normalisePostcode(p); }

  /* postcodes.io bulk lookup - up to 100 postcodes per request. */
  function bulkPostcodes(list) {
    return fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: list })
    }).then(function (res) {
      if (!res.ok) throw new Error('postcodes.io returned ' + res.status);
      return res.json();
    }).then(function (json) {
      var out = {};
      (json.result || []).forEach(function (entry) {
        if (entry && entry.result && typeof entry.result.latitude === 'number') {
          out[entry.query] = { lat: entry.result.latitude, lon: entry.result.longitude };
        }
      });
      return out;
    });
  }

  function nominatim(query) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' +
              encodeURIComponent(query);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('Nominatim returned ' + res.status);
        return res.json();
      })
      .then(function (arr) {
        if (!arr || !arr.length) return null;
        return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
      });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* sites: array of location records (mutated in place with lat/lon).
     onProgress(done, total, message) */
  function geocodeSites(sites, onProgress, useNominatim) {
    var todo = sites.filter(function (s) {
      return !(typeof s.lat === 'number' && typeof s.lon === 'number');
    });

    // Fill anything already cached before touching the network.
    todo.forEach(function (s) {
      var hit = fromCache(s.postcode) || fromCache(addressOf(s));
      if (hit) { s.lat = hit.lat; s.lon = hit.lon; s._geosrc = 'cache'; }
    });
    todo = todo.filter(function (s) { return typeof s.lat !== 'number'; });

    var total = todo.length;
    var done = 0;
    if (!total) {
      if (onProgress) onProgress(0, 0, 'Everything already has coordinates.');
      return Promise.resolve({ located: 0, failed: 0, total: 0 });
    }

    var withPostcode = todo.filter(function (s) { return looksLikePostcode(s.postcode); });
    var withoutPostcode = todo.filter(function (s) { return !looksLikePostcode(s.postcode); });
    var failed = 0, located = 0;

    // Stage 1 - bulk postcodes, 100 at a time.
    var batches = [];
    for (var i = 0; i < withPostcode.length; i += 100) batches.push(withPostcode.slice(i, i + 100));

    var chain = batches.reduce(function (p, batch) {
      return p.then(function () {
        var codes = batch.map(function (s) { return normalisePostcode(s.postcode); });
        return bulkPostcodes(codes).then(function (results) {
          batch.forEach(function (s) {
            var code = normalisePostcode(s.postcode);
            var hit = results[code];
            if (hit) {
              s.lat = hit.lat; s.lon = hit.lon; s._geosrc = 'postcode';
              toCache(s.postcode, hit.lat, hit.lon, 'postcodes.io');
              located++;
            } else {
              withoutPostcode.push(s);         // fall through to address search
            }
            done++;
            if (onProgress) onProgress(done, total, 'Looking up postcodes…');
          });
        }).catch(function (err) {
          batch.forEach(function (s) { withoutPostcode.push(s); done++; });
          if (onProgress) onProgress(done, total, 'Postcode lookup failed: ' + err.message);
        });
      });
    }, Promise.resolve());

    // Stage 2 - address search, one a second, only if asked for.
    return chain.then(function () {
      if (!useNominatim || !withoutPostcode.length) {
        failed += withoutPostcode.length;
        return;
      }
      return withoutPostcode.reduce(function (p, s) {
        return p.then(function () {
          var q = addressOf(s);
          if (!q) { failed++; return; }
          var hit = fromCache(q);
          if (hit) {
            s.lat = hit.lat; s.lon = hit.lon; s._geosrc = 'cache';
            located++;
            return;
          }
          return sleep(1100).then(function () {
            return nominatim(q).then(function (res) {
              if (res) {
                s.lat = res.lat; s.lon = res.lon; s._geosrc = 'nominatim';
                toCache(q, res.lat, res.lon, 'nominatim');
                located++;
              } else failed++;
            }).catch(function () { failed++; });
          });
        }).then(function () {
          if (onProgress) onProgress(Math.min(total, ++done - withPostcode.length + withPostcode.length), total, 'Searching addresses…');
        });
      }, Promise.resolve());
    }).then(function () {
      return { located: located, failed: failed, total: total };
    });
  }

  function addressOf(s) {
    return [s.address, s.town, s.postcode].filter(function (x) {
      return x && String(x).trim();
    }).join(', ');
  }

  function clearCache() {
    cache = {};
    global.Store.set(CACHE_KEY, cache);
  }

  function cacheSize() { return Object.keys(cache).length; }

  global.Geo = {
    geocodeSites: geocodeSites,
    looksLikePostcode: looksLikePostcode,
    normalisePostcode: normalisePostcode,
    addressOf: addressOf,
    clearCache: clearCache,
    cacheSize: cacheSize
  };
})(window);

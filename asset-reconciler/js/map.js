/* Estate map: one dot per site, area proportional to the device count.

   Radius scales with the square root of the count so that area - not radius -
   carries magnitude, which is how people actually read bubble size. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  var map = null;
  var layer = null;
  var legendCtl = null;
  var lastFit = null;
  var savedView = null;

  /* Leaflet writes marker colours as SVG presentation attributes. Support for
     var() there is not universal, so resolve the tokens to concrete colours
     against the live theme before handing them over. */
  var varCache = {};
  function cssVar(name) {
    var key = name + '|' + (document.documentElement.getAttribute('data-theme') || 'auto');
    if (varCache[key]) return varCache[key];
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) v = '#2a78d6';
    varCache[key] = v;
    return v;
  }
  function resolve(c) {
    var m = /^var\((--[a-z0-9-]+)\)$/i.exec(String(c).trim());
    return m ? cssVar(m[1]) : c;
  }
  function clearVarCache() { varCache = {}; }

  var COLOUR_MODES = {
    count:    { label: 'Device count only', legend: 'One colour: size carries the count' },
    variance: { label: 'Variance vs expected', legend: 'Red = more devices than expected, blue = fewer' },
    issues:   { label: 'Share of devices with issues', legend: 'Darker = a higher proportion flagged' }
  };

  /* Roll reconciled rows up to sites. Rows whose location resolves to a row in
     the lookup get mapped; the rest are reported separately so nothing is
     silently dropped off the visual. */
  function aggregate(rows, opts) {
    opts = opts || {};
    var groups = new Map();
    var unlocated = [];       // no location at all
    var unmatched = new Map();// a location, but not in the lookup
    var unmapped = [];        // in the lookup, but no coordinates

    rows.forEach(function (r) {
      if (!opts.includeOther && r.fs && !r.inScope) return;
      if (!r.locationKey) { unlocated.push(r); return; }
      if (!r.site) {
        if (!unmatched.has(r.locationKey)) unmatched.set(r.locationKey, { name: r.location, rows: [] });
        unmatched.get(r.locationKey).rows.push(r);
        return;
      }
      var key = r.locationKey;
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          name: N.clean(r.site.location) || r.location,
          site: r.site,
          rows: [],
          region: N.clean(r.site.region),
          expected: typeof r.site.expected === 'number' ? r.site.expected : null
        });
      }
      groups.get(key).rows.push(r);
    });

    var sites = [];
    groups.forEach(function (g) {
      var issues = g.rows.filter(function (r) { return r.issueCount > 0; }).length;
      var high = g.rows.filter(function (r) { return r.severity === 'high'; }).length;
      var lat = typeof g.site.lat === 'number' ? g.site.lat : null;
      var lon = typeof g.site.lon === 'number' ? g.site.lon : null;
      var s = {
        key: g.key,
        name: g.name,
        site: g.site,
        region: g.region,
        rows: g.rows,
        count: g.rows.length,
        issues: issues,
        high: high,
        issueRate: g.rows.length ? issues / g.rows.length : 0,
        expected: g.expected,
        variance: g.expected === null ? null : g.rows.length - g.expected,
        lat: lat, lon: lon,
        address: global.Geo.addressOf(g.site)
      };
      if (lat === null || lon === null) unmapped.push(s);
      sites.push(s);
    });

    return {
      sites: sites,
      mappable: sites.filter(function (s) { return s.lat !== null && s.lon !== null; }),
      unmapped: unmapped,
      unlocated: unlocated,
      unmatched: Array.from(unmatched.values())
    };
  }

  function radiusFor(count, maxCount) {
    var minR = 6, maxR = 34;
    if (maxCount <= 1) return minR + 4;
    var t = Math.sqrt(count) / Math.sqrt(maxCount);
    return minR + t * (maxR - minR);
  }

  function colourFor(site, mode, scale) {
    if (mode === 'variance') {
      if (site.variance === null) return 'var(--text-muted)';
      var v = site.variance;
      if (v === 0) return 'var(--div-mid)';
      var mag = Math.min(1, Math.abs(v) / (scale.maxAbsVariance || 1));
      if (v > 0) return mag > 0.5 ? 'var(--div-pos-strong)' : 'var(--div-pos)';
      return mag > 0.5 ? 'var(--div-neg-strong)' : 'var(--div-neg)';
    }
    if (mode === 'issues') {
      var r = site.issueRate;
      if (r >= 0.6) return 'var(--seq-700)';
      if (r >= 0.4) return 'var(--seq-550)';
      if (r >= 0.2) return 'var(--seq-400)';
      if (r > 0)    return 'var(--seq-250)';
      return 'var(--seq-100)';
    }
    return 'var(--series-1)';
  }

  /* Re-rendering the Map tab replaces the #map element, which would leave the
     cached Leaflet instance bound to a detached node - markers get drawn into
     a container that is no longer on the page, and the map reads as blank. So
     check the instance still owns the live element, and rebuild it if not,
     carrying the user's current pan and zoom across. */
  function ensureMap(elId) {
    if (!global.L) return null;
    var host = document.getElementById(elId);
    if (!host) return null;

    if (map) {
      var container = null;
      try { container = map.getContainer(); } catch (e) { container = null; }
      if (container === host && document.body.contains(container)) return map;

      try { savedView = { center: map.getCenter(), zoom: map.getZoom() }; } catch (e) { /* never rendered */ }
      try { map.remove(); } catch (e) { /* already torn down */ }
      map = null; layer = null; legendCtl = null;
    }

    map = global.L.map(host, { scrollWheelZoom: true, zoomControl: true, preferCanvas: false });
    if (savedView) map.setView(savedView.center, savedView.zoom);
    else map.setView([54.0, -2.4], 6);

    global.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    return map;
  }

  function render(elId, agg, opts) {
    opts = opts || {};
    var host = document.getElementById(elId);
    if (!host) return;

    if (!global.L) {
      host.innerHTML = '';
      host.appendChild(U.el('div', { class: 'empty' }, [
        U.el('div', { style: { fontWeight: '600', marginBottom: '6px' } }, 'Map library unavailable'),
        U.el('div', {}, 'Leaflet is loaded from a CDN and could not be reached. Everything else in the tool works offline; the map needs internet access.')
      ]));
      return;
    }

    var m = ensureMap(elId);
    if (!m) return;
    clearVarCache();
    if (layer) { m.removeLayer(layer); layer = null; }
    layer = global.L.layerGroup().addTo(m);

    var mode = opts.mode || 'count';
    var pts = agg.mappable;
    if (!pts.length) {
      if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
      setTimeout(function () { m.invalidateSize(); }, 60);
      return;
    }

    var maxCount = Math.max.apply(null, pts.map(function (s) { return s.count; }));
    var scale = {
      maxAbsVariance: Math.max.apply(null, pts.map(function (s) {
        return s.variance === null ? 0 : Math.abs(s.variance);
      })) || 1
    };

    // Bigger dots first so small ones stay clickable on top of them.
    pts.slice().sort(function (a, b) { return b.count - a.count; }).forEach(function (s) {
      var marker = global.L.circleMarker([s.lat, s.lon], {
        radius: radiusFor(s.count, maxCount),
        color: resolve('var(--surface-1)'),
        weight: 2,                       // surface ring, not a data border
        opacity: 0.9,
        fillColor: resolve(colourFor(s, mode, scale)),
        fillOpacity: 0.78
      });

      var lines = [
        '<h4>' + U.escapeHtml(s.name) + '</h4>',
        s.address ? '<div style="color:var(--text-secondary)">' + U.escapeHtml(s.address) + '</div>' : '',
        s.region ? '<div style="color:var(--text-muted)">' + U.escapeHtml(s.region) + '</div>' : '',
        '<div style="margin-top:8px"><strong>' + U.num(s.count) + '</strong> device' + (s.count === 1 ? '' : 's'),
        s.expected !== null ? ' · expected <strong>' + U.num(s.expected) + '</strong>' : '',
        '</div>',
        s.variance !== null && s.variance !== 0
          ? '<div style="color:' + (s.variance > 0 ? 'var(--div-pos-strong)' : 'var(--div-neg-strong)') + ';font-weight:600">' +
            (s.variance > 0 ? '+' : '') + s.variance + ' vs expected</div>'
          : '',
        '<div>' + U.num(s.issues) + ' flagged (' + Math.round(s.issueRate * 100) + '%)' +
          (s.high ? ' · <strong>' + s.high + '</strong> high severity' : '') + '</div>'
      ].join('');

      var content = U.el('div');
      content.innerHTML = lines;
      var btn = U.el('button', {
        class: 'btn sm primary',
        style: { marginTop: '10px' },
        onclick: function () { if (opts.onSelect) opts.onSelect(s); }
      }, 'View these ' + s.count + ' devices');
      content.appendChild(btn);

      marker.bindPopup(content, { maxWidth: 300 });
      marker.bindTooltip(s.name + ' · ' + s.count + ' device' + (s.count === 1 ? '' : 's'), { direction: 'top' });
      marker.addTo(layer);
    });

    /* --------------------------------------------------------- legend */
    if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
    legendCtl = global.L.control({ position: 'bottomright' });
    legendCtl.onAdd = function () {
      var div = U.el('div', { class: 'map-legend' });
      div.appendChild(U.el('div', { class: 'lg-title' }, 'Dot size'));

      var sizes = U.uniq([1, Math.max(1, Math.round(maxCount / 4)), Math.max(2, Math.round(maxCount / 2)), maxCount])
        .filter(function (v) { return v > 0; });
      var sizeRow = U.el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '10px', margin: '4px 0 8px' } });
      sizes.forEach(function (v) {
        var r = radiusFor(v, maxCount);
        sizeRow.appendChild(U.el('div', { style: { textAlign: 'center' } }, [
          U.el('div', {
            style: {
              width: (r * 2) + 'px', height: (r * 2) + 'px', borderRadius: '50%',
              background: 'var(--series-1)', opacity: '0.55', margin: '0 auto 3px'
            }
          }),
          U.el('div', { style: { fontVariantNumeric: 'tabular-nums' } }, String(v))
        ]));
      });
      div.appendChild(sizeRow);

      if (mode !== 'count') {
        div.appendChild(U.el('div', { class: 'lg-title' }, mode === 'variance' ? 'Variance' : 'Issue rate'));
        var swatches = mode === 'variance'
          ? [['var(--div-neg-strong)', 'Well under'], ['var(--div-neg)', 'Under'], ['var(--div-mid)', 'On target'],
             ['var(--div-pos)', 'Over'], ['var(--div-pos-strong)', 'Well over']]
          : [['var(--seq-100)', 'None flagged'], ['var(--seq-250)', 'Under 20%'], ['var(--seq-400)', '20–40%'],
             ['var(--seq-550)', '40–60%'], ['var(--seq-700)', 'Over 60%']];
        swatches.forEach(function (s) {
          div.appendChild(U.el('div', { class: 'lg-row' }, [
            U.el('span', { class: 'lg-sw', style: { background: s[0] } }),
            U.el('span', {}, s[1])
          ]));
        });
      }
      global.L.DomEvent.disableClickPropagation(div);
      return div;
    };
    legendCtl.addTo(m);

    // Fit once per distinct set of points, so re-colouring doesn't yank the view.
    // A map rebuilt from scratch with no remembered view needs the fit too.
    var sig = pts.length + ':' + pts.map(function (s) { return s.key; }).join(',');
    if (sig !== lastFit || !savedView) {
      lastFit = sig;
      try {
        m.fitBounds(global.L.latLngBounds(pts.map(function (s) { return [s.lat, s.lon]; })).pad(0.12));
      } catch (e) { /* single point or bad coords: leave the default view */ }
    }
    setTimeout(function () { m.invalidateSize(); }, 60);
  }

  function invalidate() {
    if (!map) return;
    setTimeout(function () {
      try {
        map.invalidateSize();
        savedView = { center: map.getCenter(), zoom: map.getZoom() };
      } catch (e) { /* container gone; the next ensureMap rebuilds */ }
    }, 60);
  }

  /* Called when the underlying site set changes enough that the view should be
     re-fitted rather than preserved. */
  function reset() { lastFit = null; savedView = null; }

  global.EstateMap = {
    aggregate: aggregate,
    render: render,
    invalidate: invalidate,
    reset: reset,
    COLOUR_MODES: COLOUR_MODES,
    radiusFor: radiusFor
  };
})(window);

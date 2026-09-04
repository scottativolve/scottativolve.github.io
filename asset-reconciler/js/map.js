/* Estate map: one dot per site, area proportional to the device count.

   Radius scales with the square root of the count so that area - not radius -
   carries magnitude, which is how people actually read bubble size.

   Two populations share the map. PCs and network assets are reconciled apart
   from each other but they sit in the same buildings, so a site's dot can
   count either or both, and the popup always breaks the total down. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  /* Great Britain, corner to corner: the Isles of Scilly to the far north of
     Scotland. Fitting these bounds rather than setting a zoom means the view
     is right whatever size the map is on the day, which a fixed zoom is not. */
  var GB_BOUNDS = [[49.85, -8.30], [58.80, 1.90]];
  var BIRMINGHAM = [52.4862, -1.8904];

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
    // Read the tokens off the map itself, not the document: the map is held
    // light whatever the app theme, and the dark ramps would be invisible on
    // a light ground.
    var host = (map && map.getContainer && map.getContainer()) || document.documentElement;
    if (varCache[name]) return varCache[name];
    var v = getComputedStyle(host).getPropertyValue(name).trim();
    if (!v) v = '#2a78d6';
    varCache[name] = v;
    return v;
  }
  function resolve(c) {
    var m = /^var\((--[a-z0-9-]+)\)$/i.exec(String(c).trim());
    return m ? cssVar(m[1]) : c;
  }
  function clearVarCache() { varCache = {}; }

  var COLOUR_MODES = {
    count:      { label: 'Device count only', legend: 'One colour: size carries the count' },
    variance:   { label: 'Variance vs expected', legend: 'Red = more devices than expected, blue = fewer',
                  populations: ['pc', 'both'] },
    issues:     { label: 'Share of devices with issues', legend: 'Darker = a higher proportion flagged' },
    netMissing: { label: 'Network kit not in Freshservice',
                  legend: 'Darker = more of the site\u2019s network kit has no Freshservice record',
                  populations: ['net', 'both'] }
  };

  var POPULATIONS = {
    pc:   { label: 'PCs', noun: 'device' },
    net:  { label: 'Network assets', noun: 'network device' },
    both: { label: 'Both', noun: 'device' }
  };

  /* Which colour modes make sense for the population on screen. */
  function modesFor(population) {
    return Object.keys(COLOUR_MODES).filter(function (k) {
      var p = COLOUR_MODES[k].populations;
      return !p || p.indexOf(population) >= 0;
    });
  }

  /* Roll reconciled rows up to sites. Rows whose location resolves to a row in
     the lookup get mapped; the rest are reported separately so nothing is
     silently dropped off the visual.

     sets is { pc: rows, net: rows }; an array is read as the PC rows alone so
     older callers keep working. opts.population decides which of the two the
     dot size and colour describe, but both are always counted, because the
     popup shows the split whichever is being sized. */
  function aggregate(sets, opts) {
    opts = opts || {};
    if (Array.isArray(sets)) sets = { pc: sets };
    var population = opts.population || 'pc';
    var lists = [
      { kind: 'pc', rows: sets.pc || [] },
      { kind: 'net', rows: sets.net || [] }
    ];

    var groups = new Map();
    var unlocated = [];       // no location at all
    var unmatched = new Map();// a location, but not in the lookup
    var unmapped = [];        // in the lookup, but no coordinates

    lists.forEach(function (list) {
      var counts = population === 'both' || population === list.kind;
      list.rows.forEach(function (r) {
        // The scope filter is a PC idea: a Freshservice record that is not a
        // computer was never going to be in Intune. Network rows are all in
        // scope for the network reconciliation by definition.
        if (list.kind === 'pc' && !opts.includeOther && r.fs && !r.inScope) return;
        if (!r.locationKey) { if (counts) unlocated.push(r); return; }
        if (!r.site) {
          if (!counts) return;
          if (!unmatched.has(r.locationKey)) unmatched.set(r.locationKey, { name: r.location, rows: [] });
          unmatched.get(r.locationKey).rows.push(r);
          return;
        }
        var key = r.locationKey;
        if (!groups.has(key)) {
          groups.set(key, {
            key: key,
            name: N.clean(r.site.location) || N.clean(r.site.name) || r.location,
            site: r.site,
            rows: [], pcRows: [], netRows: [],
            region: N.clean(r.site.region),
            expected: typeof r.site.expected === 'number' ? r.site.expected : null
          });
        }
        var g = groups.get(key);
        (list.kind === 'pc' ? g.pcRows : g.netRows).push(r);
        if (counts) g.rows.push(r);
      });
    });

    // A site that only holds the population we are not showing has no dot.
    Array.from(groups.keys()).forEach(function (k) {
      if (!groups.get(k).rows.length) groups.delete(k);
    });

    var sites = [];
    groups.forEach(function (g) {
      var issues = g.rows.filter(function (r) { return r.issueCount > 0; }).length;
      var high = g.rows.filter(function (r) { return r.severity === 'high'; }).length;
      var lat = typeof g.site.lat === 'number' ? g.site.lat : null;
      var lon = typeof g.site.lon === 'number' ? g.site.lon : null;
      var kinds = {};
      g.netRows.forEach(function (r) { kinds[r.kind || 'Other'] = (kinds[r.kind || 'Other'] || 0) + 1; });
      var netForti = g.netRows.filter(function (r) { return !!r.forti; });
      var netMissing = netForti.filter(function (r) { return !r.fs; }).length;

      var s = {
        key: g.key,
        name: g.name,
        site: g.site,
        region: g.region,
        rows: g.rows,
        count: g.rows.length,
        pcRows: g.pcRows, netRows: g.netRows,
        pcCount: g.pcRows.length, netCount: g.netRows.length,
        kinds: kinds,
        netMissing: netMissing,
        netMissingRate: netForti.length ? netMissing / netForti.length : 0,
        issues: issues,
        high: high,
        issueRate: g.rows.length ? issues / g.rows.length : 0,
        // Expected devices is a PC allowance, so a variance against a total
        // that includes switches would be nonsense.
        expected: g.expected,
        variance: g.expected === null ? null : g.pcRows.length - g.expected,
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
    if (mode === 'issues') return ramp(site.issueRate);
    if (mode === 'netMissing') {
      // A site with no network kit at all has nothing to be missing.
      if (!site.netCount) return 'var(--text-muted)';
      return ramp(site.netMissingRate);
    }
    return 'var(--series-1)';
  }

  function ramp(r) {
    if (r >= 0.6) return 'var(--seq-700)';
    if (r >= 0.4) return 'var(--seq-550)';
    if (r >= 0.2) return 'var(--seq-400)';
    if (r > 0)    return 'var(--seq-250)';
    return 'var(--seq-100)';
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
    else fitBritain(map);

    global.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    return map;
  }

  /* Open on Great Britain rather than the whole world. fitBounds needs a laid
     out container to measure, so fall back to Birmingham at a sensible zoom
     when the map is still zero-sized — the fit runs again once it is not. */
  function fitBritain(m) {
    try {
      var size = m.getSize();
      if (size.x > 40 && size.y > 40) {
        m.fitBounds(global.L.latLngBounds(GB_BOUNDS), { padding: [8, 8] });
        return true;
      }
    } catch (e) { /* not laid out yet */ }
    m.setView(BIRMINGHAM, 6);
    return false;
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
    var population = opts.population || 'pc';
    if (modesFor(population).indexOf(mode) < 0) mode = 'count';
    var pts = agg.mappable;
    if (!pts.length) {
      if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
      setTimeout(function () {
        m.invalidateSize();
        if (!savedView) fitBritain(m);
      }, 60);
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

      /* Plain words in the popup: "2 switches" reads better than the
         product name, and the naive de-camel-casing turned FortiGate into
         "Forti Gate". */
      var KIND_WORDS = {
        FortiGate: ['firewall', 'firewalls'],
        FortiSwitch: ['switch', 'switches'],
        FortiAP: ['access point', 'access points']
      };
      var KIND_ORDER = ['FortiGate', 'FortiSwitch', 'FortiAP'];
      var kindBits = Object.keys(s.kinds).sort(function (a, b) {
        var ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b);
        return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || (a < b ? -1 : 1);
      }).map(function (k) {
        var n = s.kinds[k];
        var w = KIND_WORDS[k];
        return U.num(n) + ' ' + (w ? w[n === 1 ? 0 : 1] : k);
      });

      var lines = [
        '<h4>' + U.escapeHtml(s.name) + '</h4>',
        s.address ? '<div style="color:var(--text-secondary)">' + U.escapeHtml(s.address) + '</div>' : '',
        s.region ? '<div style="color:var(--text-muted)">' + U.escapeHtml(s.region) + '</div>' : '',
        '<div style="margin-top:8px"><strong>' + U.num(s.count) + '</strong> ' +
          (population === 'net' ? 'network device' : 'device') + (s.count === 1 ? '' : 's'),
        s.expected !== null && population !== 'net'
          ? ' \u00b7 expected <strong>' + U.num(s.expected) + '</strong>' : '',
        '</div>',
        // Always show the split, whichever population is being sized: the
        // point of one map is seeing both without switching.
        population === 'both'
          ? '<div style="color:var(--text-secondary)">' + U.num(s.pcCount) + ' PC' + (s.pcCount === 1 ? '' : 's') +
            ' \u00b7 ' + U.num(s.netCount) + ' network</div>'
          : '',
        kindBits.length && population !== 'pc'
          ? '<div style="color:var(--text-secondary)">' + U.escapeHtml(kindBits.join(' \u00b7 ')) + '</div>' : '',
        s.variance !== null && s.variance !== 0 && population !== 'net'
          ? '<div style="color:' + (s.variance > 0 ? 'var(--div-pos-strong)' : 'var(--div-neg-strong)') + ';font-weight:600">' +
            (s.variance > 0 ? '+' : '') + s.variance + ' PCs vs expected</div>'
          : '',
        s.netMissing && population !== 'pc'
          ? '<div style="font-weight:600"><strong>' + U.num(s.netMissing) + '</strong> network device' +
            (s.netMissing === 1 ? '' : 's') + ' not in Freshservice</div>'
          : '',
        '<div>' + U.num(s.issues) + ' flagged (' + Math.round(s.issueRate * 100) + '%)' +
          (s.high ? ' \u00b7 <strong>' + s.high + '</strong> high severity' : '') + '</div>'
      ].join('');

      var content = U.el('div');
      content.innerHTML = lines;
      // With both populations on one dot, "view these devices" is two
      // different lists, so offer whichever ones exist rather than guessing.
      var actions = U.el('div', { class: 'row tight', style: { marginTop: '10px' } });
      if (s.pcCount && population !== 'net') {
        actions.appendChild(U.el('button', {
          class: 'btn sm primary',
          onclick: function () { if (opts.onSelect) opts.onSelect(s, 'pc'); }
        }, population === 'both' ? 'View ' + s.pcCount + ' PCs' : 'View these ' + s.count + ' devices'));
      }
      if (s.netCount && population !== 'pc') {
        actions.appendChild(U.el('button', {
          class: 'btn sm' + (population === 'net' ? ' primary' : ''),
          onclick: function () { if (opts.onSelect) opts.onSelect(s, 'net'); }
        }, population === 'both' ? 'View ' + s.netCount + ' network' : 'View these ' + s.count + ' devices'));
      }
      content.appendChild(actions);

      marker.bindPopup(content, { maxWidth: 300 });
      marker.bindTooltip(s.name + ' \u00b7 ' + s.count + ' ' +
        (population === 'net' ? 'network device' : 'device') + (s.count === 1 ? '' : 's'), { direction: 'top' });
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
        var titles = { variance: 'Variance', issues: 'Issue rate',
                       netMissing: 'Network kit not in Freshservice' };
        div.appendChild(U.el('div', { class: 'lg-title' }, titles[mode] || 'Colour'));
        var bands = [['var(--seq-100)', 'None'], ['var(--seq-250)', 'Under 20%'], ['var(--seq-400)', '20\u201340%'],
                     ['var(--seq-550)', '40\u201360%'], ['var(--seq-700)', 'Over 60%']];
        var swatches = mode === 'variance'
          ? [['var(--div-neg-strong)', 'Well under'], ['var(--div-neg)', 'Under'], ['var(--div-mid)', 'On target'],
             ['var(--div-pos)', 'Over'], ['var(--div-pos-strong)', 'Well over']]
          : mode === 'netMissing'
          ? [['var(--seq-100)', 'All recorded']].concat(bands.slice(1))
          : [['var(--seq-100)', 'None flagged']].concat(bands.slice(1));
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
      } catch (e) { fitBritain(m); }
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
    fitBritain: function () { if (map) fitBritain(map); },
    COLOUR_MODES: COLOUR_MODES,
    POPULATIONS: POPULATIONS,
    modesFor: modesFor,
    radiusFor: radiusFor
  };
})(window);

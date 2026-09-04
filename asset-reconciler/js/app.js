/* Application controller: state, the tab views, and everything that wires the
   modules together. */
(function (global) {
  'use strict';

  var U = global.U, V = global.Views, R = global.Rules, N = global.Norm,
      S = global.Schema, C = global.Charts, T = global.Table, FX = global.FSExport,
      NV = global.NetViews, NM = global.NetMatch, NX = global.NetExport, FT = global.Fortinet;

  /* Two populations, reconciled separately. PC_SOURCES feed the device
     reconciliation; NET_SOURCES feed the network one. The location lookup is
     shared, because a site is a site. */
  var PC_SOURCES = ['freshservice', 'intune', 'arcticwolf', 'locations', 'verification'];
  var NET_SOURCES = ['fortimanager', 'fsnetwork'];
  var SOURCE_IDS = PC_SOURCES.concat(NET_SOURCES);

  /* FortiManager is exported per environment, and the two exports do not have
     the same columns, so they are unioned by header name on load rather than
     pasted together in a spreadsheet, where the differing column order would
     silently shift every field. */
  var MULTI_FILE = { fortimanager: true };

  /* A config saved by an older build can be missing whole sections, and a
     shallow merge would leave the UI dereferencing keys that aren't there.
     Merge the nested objects one level down so new fields always get their
     defaults. */
  function mergeFsConfig(saved) {
    var base = FX.defaultConfig();
    if (!saved || typeof saved !== 'object') return base;
    var out = Object.assign({}, base, saved);
    // A config saved before required columns existed has no alwaysColumns; give
    // it the defaults rather than an import that Freshservice will reject.
    if (!Array.isArray(out.alwaysColumns) || !out.alwaysColumns.length) {
      out.alwaysColumns = FX.defaultAlwaysColumns();
    } else {
      // Columns saved before the source could be Intune used kind:'field',
      // which always meant Freshservice.
      out.alwaysColumns = out.alwaysColumns.map(function (c) {
        return c && c.kind === 'field' ? Object.assign({}, c, { kind: 'fs' }) : c;
      });
    }
    delete out.reference;
    delete out.referenceHeaders;

    ['fields', 'headers'].forEach(function (k) {
      out[k] = Object.assign({}, base[k], saved[k] || {});
      if (k === 'fields') {
        // Each field is itself an object; fill in any it is missing.
        Object.keys(base.fields).forEach(function (f) {
          out.fields[f] = Object.assign({}, base.fields[f], (saved.fields || {})[f] || {});
        });
      }
    });
    return out;
  }

  /* Same problem as mergeFsConfig: a config saved by an older build can be
     missing whole sections, and the lookup maps must survive untouched. */
  function mergeNetConfig(saved) {
    var base = NX.defaultConfig();
    if (!saved || typeof saved !== 'object') return base;
    var out = Object.assign({}, base, saved);
    ['headers', 'include', 'fixed'].forEach(function (k) {
      out[k] = Object.assign({}, base[k], saved[k] || {});
    });
    NX.LOOKUPS.forEach(function (l) {
      out[l.id] = Object.assign({}, saved[l.id] || {});
    });
    /* The device-type keys used to be Fortinet product lines, which was wrong
       for the Ubiquiti and other kit in the register. Carry a mapping saved
       under the old key across to the new one rather than making anyone type
       it again. */
    var RENAMED = { FortiGate: 'Firewall', FortiSwitch: 'Switch', FortiAP: 'Access point' };
    Object.keys(RENAMED).forEach(function (was) {
      var now = RENAMED[was];
      if (out.assetTypes[was] && !out.assetTypes[now]) out.assetTypes[now] = out.assetTypes[was];
      delete out.assetTypes[was];
    });
    return out;
  }

  var state = {
    sources: {},                 // id -> { fileName, headers, raw, mapping, records }
    result: null,
    cfg: global.Match.settings(global.Store.get('cfg', null) || {}),
    enabledRules: global.Store.get('enabledRules', {}),
    customViews: global.Store.get('customViews', []),
    fsConfig: mergeFsConfig(global.Store.get('fsConfig', {})),
    tab: 'data',
    viewId: 'attention',
    mapMode: global.Store.get('mapMode', 'count'),
    mapPopulation: global.Store.get('mapPopulation', 'pc'),
    mapExpanded: false,
    siteFilter: null,
    issueFilter: null,
    includeOtherOnMap: false,
    exportScope: 'all',         // 'all' | 'view' | 'selection'
    viewSearch: '',             // the quick-search box on the Devices tab
    viewColumns: null,          // the columns the current view is showing
    viewColumnsById: global.Store.get('viewColumns', {}),   // per-view column choices
    selectedIds: [],            // rows ticked on the Devices tab
    persist: global.Store.get('persist', true),   // keep the working set between visits
    author: global.Store.get('author', ''),       // name attached to notes you write
    restoredAt: null,

    /* --- network assets, reconciled separately from the PCs --- */
    netResult: null,
    netWarnings: [],
    netCfg: NM.settings(global.Store.get('netCfg', null) || {}),
    netEnabledRules: global.Store.get('netEnabledRules', {}),
    netViewId: 'net-new',
    netSearch: '',
    netColumns: null,
    netColumnsById: global.Store.get('netColumns', {}),
    netSelectedIds: [],
    netExportScope: 'view',
    netSiteFilter: null,        // a site picked off the map
    netCustomViews: global.Store.get('netCustomViews', []),
    favourites: global.Store.get('favourites', {}),          // 'pc:all' -> true
    sideOpen: global.Store.get('sideOpen', {}),             // sidebar section -> false when closed
    netConfig: mergeNetConfig(global.Store.get('netConfig', {})),
    siteOverrides: global.Store.get('siteOverrides', {}),  // device name -> site code
    envLabels: global.Store.get('envLabels', {}),          // export file -> your name for it
    envOrder: global.Store.get('envOrder', [])
  };

  var grid = null;
  var renderNoteBar = function () {};

  /* ==================================================================== */
  /*  data loading                                                        */
  /* ==================================================================== */

  function loadFiles(files, forcedSource) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;

    /* Whether each population was already complete before this batch. Only a
       population that becomes complete moves you off the Data tab: without
       this, every file dropped after Freshservice and Intune were loaded
       bounced you to the Dashboard, which made adding the FortiManager
       exports afterwards a fight. */
    var hadPc = !!(state.sources.freshservice && state.sources.intune);
    var hadNet = !!(state.sources.fortimanager && state.sources.fsnetwork);

    var jobs = list.map(function (file) {
      return global.CSV.readFile(file).then(function (parsed) {
        if (!parsed.headers.length) throw new Error(file.name + ' has no readable columns.');

        var sourceId = forcedSource;
        if (!sourceId) {
          var det = S.detectSource(parsed.headers);
          sourceId = det.source;
          if (!sourceId) {
            throw new Error('Could not tell what "' + file.name + '" is. Drop it on one of the four ' +
                            'labelled boxes to say which system it came from.');
          }
        }

        var saved = global.Store.getMapping(sourceId, parsed.headers);
        var mapping, filled = [];
        if (saved) {
          var res = S.fillMapping(sourceId, parsed.headers, saved.mapping, saved.knownFields);
          mapping = res.mapping;
          filled = res.filled;
        } else {
          mapping = S.autoMap(sourceId, parsed.headers);
        }

        // Each row remembers which file it came from, so a device can be
        // reported as being in one FortiManager environment or both.
        var envName = environmentKey(file.name);
        // Only a source that is loaded from several files has environments to
        // name; the site list is not one of them.
        if (MULTI_FILE[sourceId]) noteEnvironment(envName);
        parsed.rows.forEach(function (r) { r.__env = envName; });

        var prior = MULTI_FILE[sourceId] ? state.sources[sourceId] : null;
        if (prior && prior.files && prior.files.indexOf(file.name) >= 0) {
          // Re-dropping the same file replaces its rows rather than doubling them.
          prior.raw = prior.raw.filter(function (r) { return r.__env !== envName; });
        }

        var headers = prior ? unionHeaders(prior.headers, parsed.headers) : parsed.headers;
        var rows = prior ? prior.raw.concat(parsed.rows) : parsed.rows;
        var files = prior ? prior.files.filter(function (f) { return f !== file.name; }).concat([file.name]) : [file.name];

        if (prior) {
          /* Adding a second export to a source keeps the mapping already
             decided for the first and fills only what the union has newly
             gained — here, the IP Address column one environment exports and
             the other does not. Starting from a mapping computed for this
             file's headers alone would drop every column the other file
             contributed and then re-find it, which reads as though the saved
             mapping had been wrong. */
          var re = S.fillMapping(sourceId, headers, prior.mapping, null);
          mapping = re.mapping;
          filled = re.filled;
        }

        state.sources[sourceId] = {
          id: sourceId,
          fileName: files.join(' + '),
          files: files,
          headers: headers,
          raw: rows,
          mapping: mapping,
          knownFields: S.fieldKeys(sourceId),
          autoMapped: !saved,
          filled: filled,
          loadedAt: new Date()
        };
        project(sourceId);
        return { sourceId: sourceId, file: file.name, rows: parsed.rows.length,
                 total: rows.length, files: files.length };
      });
    });

    Promise.all(jobs).then(function (results) {
      results.forEach(function (r) {
        U.toast(S.SOURCES[r.sourceId].label + ': ' + U.num(r.rows) + ' rows from ' + r.file +
          (r.files > 1 ? ' (' + U.num(r.total) + ' rows across ' + r.files + ' files)' : ''), 'ok');
        var f = state.sources[r.sourceId] && state.sources[r.sourceId].filled;
        if (f && f.length) {
          U.toast(S.SOURCES[r.sourceId].label + ': matched ' + f.length + ' column' +
            (f.length === 1 ? '' : 's') + ' your saved mapping did not cover — ' +
            f.map(function (x) { return x.label; }).join(', ') +
            '. Check them under "Check columns".', 'ok', 11000);
        }
      });
      recompute();
      // Always redraw: the counts, the tab states and the sidebar all change,
      // whichever tab happens to be showing.
      render();
      if (state.tab === 'data') {
        /* Only leave the Data tab when a population has just become complete.
           Jumping away after the first FortiManager export also took the drop
           boxes off screen before the second environment could be added. */
        var hasPc = !!(state.sources.freshservice && state.sources.intune);
        var hasNet = !!(state.sources.fortimanager && state.sources.fsnetwork);
        if (hasPc && !hadPc) setTab('dashboard');
        else if (hasNet && !hadNet) setTab('network');
      }
    }).catch(function (err) {
      U.toast(err.message || String(err), 'err', 8000);
      render();
    });
  }

  /* Two exports of the same system rarely offer the same columns — the two
     FortiManager environments differ by four — so the union is by header
     name. Order follows the first file, with anything new appended. */
  function unionHeaders(a, b) {
    var out = (a || []).slice();
    (b || []).forEach(function (h) { if (out.indexOf(h) < 0) out.push(h); });
    return out;
  }

  /* Which environment a row came from.

     FortiManager names every export the same way — managed_devices_root_ plus
     a timestamp — so the file name says nothing about which environment it is,
     and two exports taken the same day would collapse into one label. The row
     is therefore tagged with the file name, which is unique, and the file name
     is what the user renames to something meaningful on the Data tab. */
  function environmentKey(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '');
  }

  function envLabel(key) {
    var named = state.envLabels[key];
    if (named) return named;
    var order = state.envOrder.indexOf(key);
    return order >= 0 ? 'Export ' + (order + 1) : key;
  }

  function noteEnvironment(key) {
    if (state.envOrder.indexOf(key) < 0) state.envOrder.push(key);
  }

  function project(sourceId) {
    var src = state.sources[sourceId];
    if (!src) return;
    src.records = S.project(sourceId, src.raw, src.mapping);
  }

  function recompute() {
    var data = {};
    SOURCE_IDS.forEach(function (id) {
      data[id] = state.sources[id] ? state.sources[id].records : [];
    });
    if (!data.freshservice.length && !data.intune.length) {
      state.result = null;
    } else {
      state.result = R.apply(global.Match.reconcile(data, state.cfg), state.cfg, state.enabledRules);
    }
    recomputeNet(data);
    saveWorkingSet();
  }

  /* The site list keyed by site code, which is how network devices find their
     location. Built from the same location lookup the map uses. */
  function siteIndex() {
    var src = state.sources.locations;
    var out = {};
    if (!src || !src.records) return out;
    src.records.forEach(function (r) {
      var code = normCode(r.siteCode) || codeOf(r);
      if (!code) return;
      out[code] = {
        code: code, name: N.clean(r.location), town: N.clean(r.town),
        postcode: N.clean(r.postcode), region: N.clean(r.region),
        lat: r.lat, lon: r.lon, subnet: r.subnet
      };
    });
    return out;
  }

  /* A site code is whatever the lookup calls it, normalised to three digits so
     "1", "01" and "001" are the same site. */
  function normCode(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return '';
    return /^\d+$/.test(v) ? v.replace(/^0+/, '').padStart(3, '0') : v;
  }

  /* Fallback for a site list loaded before the code column existed in the
     schema, or one whose code column the mapper could not place. */
  function codeOf(rec) {
    var raw = rec._raw || {};
    var v = '';
    Object.keys(raw).forEach(function (h) {
      if (v) return;
      if (/^\s*site\s*code\s*$/i.test(h) || /^\s*code\s*$/i.test(h)) v = raw[h];
    });
    return normCode(v);
  }

  function recomputeNet(data) {
    data = data || {};
    var forti = data.fortimanager || [];
    var fsnet = data.fsnetwork || [];
    if (!forti.length && !fsnet.length) {
      state.netResult = null;
      state.netWarnings = [];
      return;
    }
    var sites = siteIndex();
    var flat = FT.flatten(forti, { sites: sites, overrides: state.siteOverrides });
    state.netWarnings = flat.warnings;
    state.netResult = NM.apply(
      NM.reconcile(flat.devices, fsnet, state.netCfg, sites),
      state.netCfg, state.netEnabledRules);
    // Learn any lookup values the Freshservice records already answer, without
    // ever overwriting one the user typed.
    Object.assign(state.netConfig, NX.seedLookups(state.netResult.rows, state.netConfig));
  }

  /* ------------------------------------------------------ working set */

  function workingSet() {
    var payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      savedBy: state.author || '',
      cfg: state.cfg,
      enabledRules: state.enabledRules,
      customViews: state.customViews,
      fsConfig: state.fsConfig,
      netCfg: state.netCfg,
      netEnabledRules: state.netEnabledRules,
      netConfig: state.netConfig,
      netCustomViews: state.netCustomViews,
      favourites: state.favourites,
      siteOverrides: state.siteOverrides,
      envLabels: state.envLabels,
      envOrder: state.envOrder,
      sources: {}
    };
    SOURCE_IDS.forEach(function (id) {
      var src = state.sources[id];
      if (!src) return;
      payload.sources[id] = {
        fileName: src.fileName, files: src.files || null, headers: src.headers,
        mapping: src.mapping, raw: src.raw,
        knownFields: src.knownFields || S.fieldKeys(id)
      };
    });
    return payload;
  }

  var persistFailed = false;
  var saveWorkingSet = U.debounce(function () {
    if (!state.persist || !global.DB.available) return;
    if (!Object.keys(state.sources).length) return;
    global.DB.save(workingSet()).then(function () {
      state.savedAt = new Date();
      persistFailed = false;
    }).catch(function (err) {
      if (persistFailed) return;              // say it once, not on every keystroke
      persistFailed = true;
      U.toast(err.message + ' Your data is still loaded in this tab, but it will not come back ' +
              'next time — use "Save project" instead.', 'err', 10000);
    });
  }, 900);

  function restoreWorkingSet() {
    if (!state.persist || !global.DB.available) return Promise.resolve(false);
    var restoredFills = [];
    return global.DB.load().then(function (payload) {
      if (!payload || !payload.sources || !Object.keys(payload.sources).length) return false;
      Object.keys(payload.sources).forEach(function (id) {
        var src = payload.sources[id];
        if (!src || !src.raw) return;
        // A stored working set carries the mapping the build that saved it
        // produced, so fields added since are missing from it. Fill those in
        // rather than leaving their columns quietly blank.
        var res = S.fillMapping(id, src.headers, src.mapping, src.knownFields);
        state.sources[id] = {
          id: id, fileName: src.fileName, files: src.files || [src.fileName],
          headers: src.headers,
          mapping: res.mapping, raw: src.raw,
          knownFields: S.fieldKeys(id),
          filled: res.filled
        };
        if (res.filled.length) restoredFills.push({ source: id, filled: res.filled });
        project(id);
      });
      if (payload.cfg) state.cfg = global.Match.settings(payload.cfg);
      if (payload.enabledRules) state.enabledRules = payload.enabledRules;
      if (payload.customViews) state.customViews = payload.customViews;
      if (payload.fsConfig) state.fsConfig = mergeFsConfig(payload.fsConfig);
      if (payload.netCfg) state.netCfg = NM.settings(payload.netCfg);
      if (payload.netEnabledRules) state.netEnabledRules = payload.netEnabledRules;
      if (payload.netConfig) state.netConfig = mergeNetConfig(payload.netConfig);
      if (payload.netCustomViews) state.netCustomViews = payload.netCustomViews;
      if (payload.favourites) state.favourites = payload.favourites;
      if (payload.siteOverrides) state.siteOverrides = payload.siteOverrides;
      if (payload.envLabels) state.envLabels = payload.envLabels;
      if (payload.envOrder) state.envOrder = payload.envOrder;
      state.restoredAt = payload.savedAt ? new Date(payload.savedAt) : null;
      state.savedAt = state.restoredAt;
      state.restoredFills = restoredFills;
      recompute();
      return true;
    }).catch(function () { return false; });
  }

  function forgetWorkingSet(alsoClearLoaded) {
    return global.DB.clear().then(function () {
      state.savedAt = null;
      state.restoredAt = null;
      if (alsoClearLoaded) {
        state.sources = {};
        state.result = null;
        state.siteFilter = null;
        state.issueFilter = null;
        global.EstateMap.reset();
      }
      render();
    });
  }

  function clearSource(id) {
    delete state.sources[id];
    recompute();
    if (!Object.keys(state.sources).length) global.DB.clear();
    render();
  }

  /* ==================================================================== */
  /*  views + filtering                                                   */
  /* ==================================================================== */

  function allViews() {
    return V.BUILT_IN.concat(state.customViews.map(function (v) {
      return Object.assign({}, v, { isCustom: true });
    }));
  }

  function viewById(id) {
    return allViews().filter(function (v) { return v.id === id; })[0] || V.BUILT_IN[1];
  }

  /* withSearch reproduces the quick-search box as well as the view's own
     filter, so "what the export covers" can be made to equal "what I was
     looking at". */
  function rowsForView(view, withSearch) {
    if (!state.result) return [];
    var rows = V.applyView(view, state.result.rows);
    if (state.siteFilter) {
      rows = rows.filter(function (r) { return r.locationKey === state.siteFilter.key; });
    }
    if (state.issueFilter) {
      rows = rows.filter(function (r) { return r.issues.indexOf(state.issueFilter) >= 0; });
    }
    if (withSearch && state.viewSearch) {
      rows = V.searchRows(rows, state.viewSearch);
    }
    return rows;
  }

  /* ---------------------------------------------------- network views */

  function netViews() {
    return NV.BUILT_IN.concat(state.netCustomViews.map(function (v) {
      return Object.assign({}, v, { isCustom: true });
    }));
  }

  function netViewById(id) {
    return netViews().filter(function (v) { return v.id === id; })[0] || NV.BUILT_IN[0];
  }

  function netRowsForView(view, withSearch) {
    if (!state.netResult) return [];
    var rows = NV.applyView(view, state.netResult.rows);
    if (state.netSiteFilter) {
      rows = rows.filter(function (r) { return r.locationKey === state.netSiteFilter.key; });
    }
    if (withSearch && state.netSearch) rows = NV.searchRows(rows, state.netSearch);
    return rows;
  }

  function netViewCount(view) {
    if (!state.netResult) return 0;
    try { return NV.applyView(view, state.netResult.rows).length; } catch (e) { return 0; }
  }

  /* Show one site's network kit, from a click on the map. */
  function setNetSite(site) {
    state.netSiteFilter = { key: site.key, name: site.name };
    setNetView('net-all');
  }

  function netSelectedRows() {
    if (!state.netResult || !state.netSelectedIds.length) return [];
    var wanted = {};
    state.netSelectedIds.forEach(function (id) { wanted[id] = true; });
    return state.netResult.rows.filter(function (r) { return wanted[r.id]; });
  }

  function setNetView(id) {
    if (id !== state.netViewId) {
      state.netSearch = '';
      state.netSelectedIds = [];
    }
    state.netViewId = id;
    setTab('network');
  }

  function selectedRows() {
    if (!state.result || !state.selectedIds.length) return [];
    var wanted = {};
    state.selectedIds.forEach(function (id) { wanted[id] = true; });
    return state.result.rows.filter(function (r) { return wanted[r.id]; });
  }

  function viewCount(view) {
    if (!state.result) return 0;
    try { return V.applyView(view, state.result.rows).length; } catch (e) { return 0; }
  }

  /* ==================================================================== */
  /*  shell                                                               */
  /* ==================================================================== */

  function setTab(tab) {
    state.tab = tab;
    render();
    if (tab === 'map') global.EstateMap.invalidate();
  }

  function setView(id) {
    if (id !== state.viewId) {
      // A search typed against one view rarely means the same thing in
      // another, and silently carrying it over would hide rows.
      state.viewSearch = '';
      state.selectedIds = [];
    }
    state.viewId = id;
    state.issueFilter = null;
    setTab('devices');
  }

  function renderHeader() {
    var host = U.qs('#header');
    U.clear(host);

    var tabs = [
      ['data', 'Data'],
      ['dashboard', 'Dashboard'],
      ['dupes', 'Duplicates'],
      ['devices', 'Devices'],
      ['network', 'Network'],
      ['map', 'Map'],
      ['export', 'Freshservice import'],
      ['settings', 'Settings']
    ];
    tabs.forEach(function (t) {
      // The two populations load independently: network exports alone should
      // open the Network tab without the PC reconciliation being present.
      var needs = { network: !!state.netResult, data: true, settings: true,
                    map: !!(state.result || state.netResult) };
      var disabled = !(Object.prototype.hasOwnProperty.call(needs, t[0]) ? needs[t[0]] : !!state.result);
      host.appendChild(U.el('button', {
        class: 'tab' + (state.tab === t[0] ? ' active' : ''),
        disabled: disabled,
        style: disabled ? { opacity: '0.4', cursor: 'not-allowed' } : null,
        onclick: function () { if (!disabled) setTab(t[0]); }
      }, t[1]));
    });

    host.appendChild(U.el('div', { class: 'spacer' }));

    if (state.tab === 'network' && state.netResult) {
      host.appendChild(U.el('span', { class: 'hint', style: { whiteSpace: 'nowrap' } },
        U.num(state.netResult.rows.length) + ' network devices \u00b7 ' +
        U.num(state.netResult.rows.filter(function (r) { return r.issueCount; }).length) + ' flagged'));
    } else if (state.result) {
      host.appendChild(U.el('span', { class: 'hint', style: { whiteSpace: 'nowrap' } },
        U.num(state.result.rows.length) + ' devices \u00b7 ' +
        U.num(state.result.rows.filter(function (r) { return r.issueCount; }).length) + ' flagged'));
    }

    host.appendChild(U.el('button', {
      class: 'btn sm ghost', title: 'Save everything loaded, including the data, to a file you can reopen later',
      onclick: saveProject
    }, 'Save project'));
    host.appendChild(U.el('button', {
      class: 'btn sm ghost', title: 'Reopen a saved project file', onclick: openProject
    }, 'Open'));

    var dark = document.documentElement.getAttribute('data-theme');
    host.appendChild(U.el('button', {
      class: 'btn sm ghost', title: 'Switch between light and dark',
      onclick: function () {
        var next = dark === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        global.Store.set('theme', next);
        render();
      }
    }, dark === 'dark' ? '☀' : '☾'));
  }

  /* --------------------------------------------------------- sidebar */

  /* Sections remember whether they are open. Default open, so nothing is
     hidden from someone who has never touched the control. */
  function sectionOpen(key) {
    return state.sideOpen[key] !== false;
  }

  function toggleSection(key) {
    state.sideOpen[key] = !sectionOpen(key);
    global.Store.set('sideOpen', state.sideOpen);
    render();
  }

  /* A collapsible sidebar section. add is an optional { title, onclick }
     button that sits in the header alongside the collapse arrow. */
  function sideSection(key, title, add) {
    var open = sectionOpen(key);
    var sec = U.el('div', { class: 'side-section' + (open ? '' : ' closed') });
    var head = U.el('div', { class: 'side-head' });
    head.appendChild(U.el('button', {
      class: 'side-toggle',
      'aria-expanded': open ? 'true' : 'false',
      title: open ? 'Hide ' + title : 'Show ' + title,
      onclick: function () { toggleSection(key); }
    }, [
      U.el('span', { class: 'caret' }, caretIcon()),
      U.el('span', {}, title)
    ]));
    head.appendChild(U.el('div', { class: 'spacer' }));
    if (add) {
      head.appendChild(U.el('button', {
        class: 'btn sm ghost', style: { padding: '0 4px' },
        title: add.title,
        onclick: function (e) { e.stopPropagation(); add.onclick(); }
      }, add.label || '+'));
    }
    sec.appendChild(head);
    var bodyEl = U.el('div', { class: 'side-body' });
    sec.appendChild(bodyEl);
    return { el: sec, body: open ? bodyEl : null, open: open };
  }

  /* One chevron, rotated by CSS when the section is closed. */
  function caretIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 4.5 L6 8.5 L10 4.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function favKey(ctxKey, viewId) { return ctxKey + ':' + viewId; }

  function isFavourite(ctxKey, viewId) { return !!state.favourites[favKey(ctxKey, viewId)]; }

  function toggleFavourite(ctxKey, viewId) {
    var k = favKey(ctxKey, viewId);
    if (state.favourites[k]) delete state.favourites[k];
    else state.favourites[k] = true;
    global.Store.set('favourites', state.favourites);
    render();
  }

  /* One row for one view, in whichever section it is being listed. */
  function viewItem(ctx, v, opts) {
    opts = opts || {};
    var fav = isFavourite(ctx.key, v.id);
    return U.el('button', {
      class: 'side-item' + (ctx.currentId() === v.id && ctx.isActive() ? ' active' : ''),
      // The name as well as the description: a long name is truncated in a
      // 260px sidebar, and a favourite you cannot read is no use.
      title: v.name + (v.description ? ' \u2014 ' + v.description : ''),
      onclick: function () { ctx.open(v.id); }
    }, [
      U.el('span', { class: 'side-name' },
        opts.showPopulation
          ? [U.el('span', { class: 'side-tag' }, ctx.key === 'net' ? 'Net' : 'PC'), ' ', v.name]
          : v.name),
      U.el('span', { class: 'count' }, U.num(ctx.count(v))),
      U.el('span', {
        class: 'del star' + (fav ? ' on' : ''),
        title: fav ? 'Remove from favourites' : 'Add to favourites',
        onclick: function (e) { e.stopPropagation(); toggleFavourite(ctx.key, v.id); }
      }, fav ? '★' : '☆'),
      U.el('span', {
        class: 'del',
        title: v.isCustom ? 'Edit this view' : 'See how this view is defined',
        onclick: function (e) {
          e.stopPropagation();
          openViewBuilder(ctx, v, v.isCustom ? 'edit' : 'inspect');
        }
      }, '⚙'),
      v.isCustom ? U.el('span', {
        class: 'del', title: 'Delete this view',
        onclick: function (e) {
          e.stopPropagation();
          if (!confirm('Delete the view "' + v.name + '"? Devices and notes are not affected.')) return;
          ctx.saveCustom(ctx.custom.filter(function (x) { return x.id !== v.id; }));
          delete ctx.columnsById[v.id];
          ctx.saveColumns();
          delete state.favourites[favKey(ctx.key, v.id)];
          global.Store.set('favourites', state.favourites);
          if (ctx.currentId() === v.id) ctx.open(ctx.fallbackId);
          render();
        }
      }, '✕') : null
    ]);
  }

  function renderSidebar() {
    var host = U.qs('#sidebar');
    U.clear(host);

    /* sources */
    var srcSec = sideSection('sources', 'Sources');
    if (srcSec.body) {
      SOURCE_IDS.forEach(function (id) {
        var src = state.sources[id];
        var def = S.SOURCES[id];
        srcSec.body.appendChild(U.el('button', {
          class: 'side-item',
          onclick: function () { setTab('data'); }
        }, [
          U.el('span', { class: 'dot', style: { background: src ? 'var(--good)' : 'var(--surface-3)' } }),
          U.el('span', { class: 'side-name' }, def.short),
          U.el('span', { class: 'count' }, src ? U.num(src.records ? src.records.length : 0) : '—')
        ]));
      });
    }
    host.appendChild(srcSec.el);

    var contexts = [];
    if (state.result) contexts.push(pcCtx());
    if (state.netResult) contexts.push(netCtx());
    if (!contexts.length) return;

    /* Favourites first: the whole point is that the views someone uses every
       day are not buried in a list of twenty. Starred views from both
       populations sit together, tagged so it is clear which list is which. */
    var starred = [];
    contexts.forEach(function (ctx) {
      ctx.all().forEach(function (v) {
        if (isFavourite(ctx.key, v.id)) starred.push({ ctx: ctx, view: v });
      });
    });
    if (starred.length) {
      var favSec = sideSection('favourites', 'Favourites');
      if (favSec.body) {
        starred.forEach(function (f) {
          favSec.body.appendChild(viewItem(f.ctx, f.view, { showPopulation: contexts.length > 1 }));
        });
      }
      host.appendChild(favSec.el);
    }

    contexts.forEach(function (ctx) {
      var sec = sideSection(ctx.key + '-views', ctx.label, {
        title: 'Create a ' + ctx.noun + ' view with your own filter',
        // Wrapped, not passed by reference: the handler's first argument would
        // otherwise be the click event, which openViewBuilder reads as a view.
        onclick: function () { openViewBuilder(ctx); }
      });
      if (sec.body) {
        ctx.all().forEach(function (v) { sec.body.appendChild(viewItem(ctx, v)); });
      }
      host.appendChild(sec.el);
    });

    /* active filters */
    var filters = [];
    if (state.siteFilter) {
      filters.push(['Site: ' + U.truncate(state.siteFilter.name, 18),
                    function () { state.siteFilter = null; render(); }]);
    }
    if (state.issueFilter) {
      filters.push([(R.BY_CODE[state.issueFilter] || {}).label || state.issueFilter,
                    function () { state.issueFilter = null; render(); }]);
    }
    if (state.netSiteFilter) {
      filters.push(['Network site: ' + U.truncate(state.netSiteFilter.name, 14),
                    function () { state.netSiteFilter = null; render(); }]);
    }
    if (filters.length) {
      var fsec = sideSection('filters', 'Active filter');
      if (fsec.body) {
        filters.forEach(function (f) {
          fsec.body.appendChild(U.el('button', {
            class: 'side-item', onclick: f[1]
          }, [
            U.el('span', { class: 'side-name' }, f[0]),
            U.el('span', { class: 'del', style: { opacity: 1 } }, '✕')
          ]));
        });
      }
      host.appendChild(fsec.el);
    }
  }

  /* Emptying the page fires change/blur on whichever field had focus, and those
     handlers commit their value and ask for a re-render - from inside the
     render that is already tearing the page down. Collapse that into one
     re-render after the current pass instead of letting them interleave. */
  var rendering = false;
  var renderQueued = false;

  function render() {
    if (rendering) { renderQueued = true; return; }
    rendering = true;
    try {
      renderHeader();
      renderSidebar();
      var main = U.qs('#main');
      U.clear(main);
      /* Every page but these three reads a reconciliation result and would
         throw without one. The tabs are disabled in that state, but a tab can
         also be reached from a restored session or a stale state, so the
         fallback lives here rather than in eight separate guards. */
      var page = {
        data: renderData,
        dashboard: renderDashboard,
        dupes: renderDupes,
        devices: renderDevices,
        network: renderNetwork,
        map: renderMap,
        export: renderExport,
        settings: renderSettings
      }[state.tab] || renderData;
      var ready = state.tab === 'data' || state.tab === 'settings'
        ? true
        : state.tab === 'network' ? !!state.netResult
        : state.tab === 'map' ? !!(state.result || state.netResult)
        : !!state.result;
      (ready ? page : renderData)(main);
    } finally {
      rendering = false;
    }
    if (renderQueued) { renderQueued = false; render(); }
  }

  /* ==================================================================== */
  /*  tab: data                                                           */
  /* ==================================================================== */

  function dropZone(sourceId) {
    var def = S.SOURCES[sourceId];
    var src = state.sources[sourceId];

    var input = U.el('input', {
      type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls',
      multiple: !!MULTI_FILE[sourceId], style: { display: 'none' },
      onchange: function (e) { loadFiles(e.target.files, sourceId); e.target.value = ''; }
    });

    var zone = U.el('div', {
      class: 'drop' + (src ? ' loaded' : ''),
      tabindex: '0', role: 'button',
      onclick: function () { input.click(); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
      ondragover: function (e) { e.preventDefault(); zone.classList.add('over'); },
      ondragleave: function () { zone.classList.remove('over'); },
      ondrop: function (e) {
        e.preventDefault(); zone.classList.remove('over');
        loadFiles(e.dataTransfer.files, sourceId);
      }
    }, [
      U.el('div', { class: 'dz-title' }, def.label),
      U.el('div', { class: 'dz-sub' }, def.hint),
      src ? U.el('div', { class: 'dz-file' },
        MULTI_FILE[sourceId] && src.files && src.files.length > 1
          ? src.files.length + ' files loaded'
          : src.fileName) : null,
      src ? U.el('div', { class: 'dz-meta' }, U.num(src.raw.length) + ' rows \u00b7 ' +
            Object.keys(src.mapping).length + ' of ' + def.fields.length + ' columns mapped') : null,
      input
    ]);

    var wrap = U.el('div', {}, zone);
    if (src) {
      wrap.appendChild(U.el('div', { class: 'row tight', style: { marginTop: '8px', justifyContent: 'center' } }, [
        U.el('button', { class: 'btn sm', onclick: function () { openMappingModal(sourceId); } }, 'Check columns'),
        U.el('button', {
          class: 'btn sm',
          title: 'Read the file exactly as it was parsed, before any mapping',
          onclick: function () { openFileViewer(sourceId); }
        }, 'View file'),
        U.el('button', { class: 'btn sm ghost', onclick: function () { clearSource(sourceId); } }, 'Remove')
      ]));
      if (MULTI_FILE[sourceId] && src.files) {
        var envs = U.el('div', { style: { marginTop: '8px' } });
        envs.appendChild(U.el('div', { class: 'hint', style: { textAlign: 'center' } },
          src.files.length > 1
            ? 'Both exports are held together, unioned by column name.'
            : 'Drop the other environment\u2019s export here too \u2014 it is added, not replaced.'));
        src.files.forEach(function (fileName) {
          var key = environmentKey(fileName);
          var n = src.raw.filter(function (r) { return r.__env === key; }).length;
          envs.appendChild(U.el('div', { class: 'row tight', style: { marginTop: '4px' } }, [
            U.el('input', {
              type: 'text', value: envLabel(key), title: fileName,
              placeholder: 'Name this environment\u2026',
              style: { flex: '1', minWidth: '0', fontSize: '11.5px' },
              onchange: function (e) {
                var v = e.target.value.trim();
                if (v) state.envLabels[key] = v; else delete state.envLabels[key];
                global.Store.set('envLabels', state.envLabels);
                global.Store.set('envOrder', state.envOrder);
                render();
              }
            }),
            U.el('span', { class: 'hint', style: { whiteSpace: 'nowrap' } }, U.num(n) + ' rows')
          ]));
        });
        wrap.appendChild(envs);
      }

      var missingReq = def.fields.filter(function (f) { return f.required && !src.mapping[f.key]; });
      if (missingReq.length) {
        wrap.appendChild(U.el('div', {
          class: 'hint', style: { color: 'var(--critical)', textAlign: 'center', marginTop: '4px' }
        }, 'Missing required column: ' + missingReq.map(function (f) { return f.label; }).join(', ')));
      }
    }
    return wrap;
  }

  /* Read a loaded file as it was actually parsed.

     This is the raw grid — every column the file has, under its own heading,
     before any mapping — so a value that looks wrong in a view can be checked
     against what the export really said. Paged, because a FortiManager export
     is a thousand rows and no browser enjoys a thousand-row table. */
  function openFileViewer(sourceId) {
    var src = state.sources[sourceId];
    if (!src) return;
    var def = S.SOURCES[sourceId];
    var indentKey = (global.CSV && global.CSV.INDENT) || '__indent';

    var page = 0, pageSize = 50, query = '', envFilter = '';

    /* The line each row sits on in the file it came from, counting the header
       as line 1. Worked out once, because a filtered or searched page must
       still point at the right line in the real file. */
    var lineOf = new Map();
    var perFile = {};
    src.raw.forEach(function (r) {
      var e = r.__env || '';
      perFile[e] = (perFile[e] || 1) + 1;
      lineOf.set(r, perFile[e]);
    });

    var body = U.el('div', { class: 'body' });

    var info = U.el('div', { class: 'hint', style: { marginBottom: '8px' } });
    body.appendChild(info);

    var controls = U.el('div', { class: 'row', style: { marginBottom: '10px' } });
    controls.appendChild(U.el('input', {
      type: 'search', placeholder: 'Search every column\u2026', style: { minWidth: '220px' },
      oninput: U.debounce(function (e) { query = e.target.value; page = 0; draw(); }, 180)
    }));
    if (MULTI_FILE[sourceId] && src.files && src.files.length > 1) {
      var sel = U.el('select', {
        onchange: function (e) { envFilter = e.target.value; page = 0; draw(); }
      }, [U.el('option', { value: '' }, 'All files')].concat(src.files.map(function (f) {
        var k = environmentKey(f);
        return U.el('option', { value: k }, envLabel(k));
      })));
      controls.appendChild(sel);
    }
    controls.appendChild(U.el('div', { class: 'spacer' }));
    controls.appendChild(U.el('button', {
      class: 'btn sm ghost',
      title: 'Save exactly these rows and columns back out as a CSV',
      onclick: function () {
        var rows = filtered();
        if (!rows.length) { U.toast('Nothing to export.', 'err'); return; }
        U.download(sourceId + '-as-loaded-' + U.todayStamp() + '.csv',
          global.CSV.stringify(rows.map(strip), src.headers));
      }
    }, 'Export what I am looking at'));
    body.appendChild(controls);

    var tableHost = U.el('div');
    body.appendChild(tableHost);
    var pager = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    body.appendChild(pager);

    /* The synthetic indent key is ours, not the file's, so it never appears
       as a column or in an export of the file. */
    function strip(row) {
      var out = {};
      src.headers.forEach(function (h) { out[h] = row[h] === undefined ? '' : row[h]; });
      return out;
    }

    function filtered() {
      var rows = src.raw;
      if (envFilter) rows = rows.filter(function (r) { return r.__env === envFilter; });
      rows = rows.slice();
      var q = query.toLowerCase().trim();
      if (!q) return rows;
      return rows.filter(function (r) {
        for (var i = 0; i < src.headers.length; i++) {
          var v = r[src.headers[i]];
          if (v && String(v).toLowerCase().indexOf(q) >= 0) return true;
        }
        return false;
      });
    }

    function draw() {
      var rows = filtered();
      var pages = Math.max(1, Math.ceil(rows.length / pageSize));
      if (page >= pages) page = pages - 1;
      var slice = rows.slice(page * pageSize, (page + 1) * pageSize);

      U.clear(info);
      info.appendChild(U.el('span', {},
        (src.files && src.files.length > 1 ? src.files.length + ' files, ' : '') +
        U.num(src.raw.length) + ' rows \u00b7 ' + src.headers.length + ' columns' +
        (rows.length === src.raw.length ? '' : ' \u00b7 ' + U.num(rows.length) + ' matching')));

      U.clear(tableHost);
      if (!rows.length) {
        tableHost.appendChild(U.el('div', { class: 'empty' }, 'Nothing in this file matches that.'));
      } else {
        var wrap = U.el('div', { class: 'table-wrap', style: { maxHeight: '52vh' } });
        var table = U.el('table', { class: 'grid' });
        var htr = U.el('tr');
        htr.appendChild(U.el('th', {
          class: 'nosort', style: { width: '52px' },
          title: 'The line this row sits on in its own file, counting the header as line 1'
        }, 'Line'));
        src.headers.forEach(function (h) {
          // Say which field a column feeds, so the mapping is visible here too.
          var field = Object.keys(src.mapping).filter(function (k) { return src.mapping[k] === h; })[0];
          var fdef = field ? S.fieldDef(sourceId, field) : null;
          htr.appendChild(U.el('th', { class: 'nosort', title: fdef ? 'Read as: ' + fdef.label : 'Not mapped to any field' }, [
            U.el('div', {}, h),
            U.el('div', {
              class: 'hint',
              style: { fontWeight: '400', textTransform: 'none', letterSpacing: '0', fontSize: '10px' }
            }, fdef ? fdef.label : '\u2014')
          ]));
        });
        table.appendChild(U.el('thead', {}, htr));
        var tbody = U.el('tbody');
        slice.forEach(function (r) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td', { class: 'num muted' }, String(lineOf.get(r) || '')));
          src.headers.forEach(function (h, i) {
            var v = r[h] === undefined || r[h] === null ? '' : String(r[h]);
            // FortiManager's tree depth is the leading whitespace of the first
            // column, which the parser records separately; show it back so the
            // hierarchy is visible in the raw view too.
            var pad = i === 0 ? Number(r[indentKey] || 0) : 0;
            tr.appendChild(U.el('td', { style: pad ? { paddingLeft: (8 + pad * 7) + 'px' } : null },
              v ? U.truncate(v, 60) : U.el('span', { class: 'muted' }, '\u2014')));
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        tableHost.appendChild(wrap);
      }

      U.clear(pager);
      pager.appendChild(U.el('button', {
        class: 'btn sm', disabled: page === 0,
        onclick: function () { page--; draw(); }
      }, 'Previous'));
      pager.appendChild(U.el('span', { class: 'hint' }, 'Page ' + (page + 1) + ' of ' + pages));
      pager.appendChild(U.el('button', {
        class: 'btn sm', disabled: page >= pages - 1,
        onclick: function () { page++; draw(); }
      }, 'Next'));
    }
    draw();

    modal(def.label + ' \u2014 ' + (src.files && src.files.length > 1 ? src.files.join(', ') : src.fileName),
      body, [{ label: 'Close', primary: true }], { wide: true });
  }

  function renderData(main) {
    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Load your exports'),
      U.el('div', { class: 'sub' },
        'Drop the CSVs straight in. Nothing is uploaded anywhere — the files are read in this browser tab and the ' +
        'data never leaves your machine.' +
        (state.persist && global.DB.available
          ? ' It is kept in this browser so it is still here when you come back.'
          : ' It is held in this tab only, so closing it loses the data.'))
    ]));

    if (state.result && global.DB.available) {
      main.appendChild(U.el('div', {
        class: 'row', style: { marginBottom: '14px', fontSize: '12.5px', color: 'var(--text-secondary)' }
      }, [
        U.el('span', { class: 'badge ' + (state.persist ? 'ok' : 'low') }, [
          U.el('span', { class: 'sev sev-' + (state.persist ? 'ok' : 'low') }),
          state.persist ? 'Saved on this computer' : 'Not being saved'
        ]),
        state.persist && state.savedAt
          ? U.el('span', {}, 'last saved ' + state.savedAt.toLocaleString('en-GB', {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
          : null,
        state.persist ? U.el('button', {
          class: 'btn sm ghost',
          onclick: function () {
            if (!confirm('Remove the loaded data from this browser and start with an empty tool?')) return;
            forgetWorkingSet(true).then(function () { U.toast('Cleared.', 'ok'); });
          }
        }, 'Clear and start again') : null,
        U.el('button', {
          class: 'btn sm ghost', onclick: function () { setTab('settings'); }
        }, state.persist ? 'Turn off' : 'Turn on')
      ]));
    }

    // The generic area takes several files at once and works out what each one
    // is from its headings; the labelled boxes below take one file each and
    // skip the guessing.
    var anyInput = U.el('input', {
      type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls', multiple: true, style: { display: 'none' },
      onchange: function (e) { loadFiles(e.target.files); e.target.value = ''; }
    });
    var anyZone = U.el('div', {
      class: 'card',
      style: { textAlign: 'center', padding: '22px', borderStyle: 'dashed', cursor: 'pointer' },
      onclick: function (e) { if (e.target.tagName !== 'INPUT') anyInput.click(); },
      ondragover: function (e) { e.preventDefault(); anyZone.style.borderColor = 'var(--accent)'; },
      ondragleave: function () { anyZone.style.borderColor = ''; },
      ondrop: function (e) { e.preventDefault(); anyZone.style.borderColor = ''; loadFiles(e.dataTransfer.files); }
    }, [
      U.el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, 'Drop your export files here'),
      U.el('div', { class: 'hint' }, 'Several at once is fine — each file is identified by its column headings. ' +
        'Use the labelled boxes below if a file is not recognised.'),
      U.el('button', { class: 'btn sm', style: { marginTop: '10px' } }, 'Choose files'),
      anyInput
    ]);
    main.appendChild(anyZone);

    var drops = U.el('div', { class: 'drops' });
    SOURCE_IDS.forEach(function (id) { drops.appendChild(dropZone(id)); });
    main.appendChild(drops);

    if (!state.result) {
      main.appendChild(U.el('div', { class: 'card', style: { marginTop: '16px' } }, [
        U.el('h2', {}, 'Not sure where to start?'),
        U.el('p', { class: 'hint' },
          'Load a small set of made-up data to see what the tool does. It has the same shape as the real exports, ' +
          'with the same kinds of problems deliberately built in.'),
        U.el('button', { class: 'btn primary', onclick: loadSample }, 'Load sample data')
      ]));
    }

    if (state.result) {
      var c = state.result.counts;
      main.appendChild(U.el('div', { class: 'card', style: { marginTop: '16px' } }, [
        U.el('h2', {}, 'How the records matched up'),
        U.el('div', { class: 'tiles', style: { marginTop: '12px', marginBottom: '0' } }, [
          C.tile('Freshservice rows', c.fs),
          C.tile('Intune rows', c.intune),
          C.tile('Matched to each other', c.matched, c.bySerial + ' on serial, ' + c.byName + ' on name'),
          C.tile('Freshservice only', c.fsOnly),
          C.tile('Intune only', c.intuneOnly),
          C.tile('Locations in lookup', c.locations)
        ])
      ]));
    }
  }

  /* -------------------------------------------------------- mapping modal */

  function openMappingModal(sourceId) {
    var src = state.sources[sourceId];
    var def = S.SOURCES[sourceId];
    if (!src) return;
    var working = Object.assign({}, src.mapping);

    function sampleFor(header) {
      for (var i = 0; i < Math.min(40, src.raw.length); i++) {
        var v = src.raw[i][header];
        if (v !== undefined && v !== null && String(v).trim() !== '') return U.truncate(String(v), 30);
      }
      return '';
    }

    var body = U.el('div', { class: 'body' });
    body.appendChild(U.el('p', { class: 'hint' },
      'The tool guessed these from your column headings. Change anything it got wrong — your choices are ' +
      'remembered for any future export with the same columns.'));

    var unmapped = def.fields.filter(function (f) { return !working[f.key]; });
    if (unmapped.length) {
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '10px' } },
        unmapped.length + ' field' + (unmapped.length === 1 ? '' : 's') + ' not matched to a column: ' +
        unmapped.map(function (f) { return f.label; }).join(', ') +
        '. Anything unmatched shows as blank in the views, so set it here if your export has it under another name.'));
    }

    var table = U.el('table', { class: 'map-table' });
    table.appendChild(U.el('thead', {}, U.el('tr', {}, [
      U.el('th', {}, 'What the tool needs'),
      U.el('th', {}, 'Column in your file'),
      U.el('th', {}, 'Example value')
    ])));
    var tb = U.el('tbody');

    def.fields.forEach(function (f) {
      var sampleCell = U.el('td', { class: 'hint' }, working[f.key] ? sampleFor(working[f.key]) : '');
      var sel = U.el('select', {
        onchange: function (e) {
          working[f.key] = e.target.value || undefined;
          if (!e.target.value) delete working[f.key];
          sampleCell.textContent = e.target.value ? sampleFor(e.target.value) : '';
        }
      }, [U.el('option', { value: '' }, '— not in this file —')].concat(
        src.headers.map(function (h) {
          return U.el('option', { value: h, selected: working[f.key] === h }, h);
        })
      ));
      tb.appendChild(U.el('tr', {}, [
        U.el('td', {}, [f.label, f.required ? U.el('span', { class: 'req' }, ' *') : null]),
        U.el('td', {}, sel),
        sampleCell
      ]));
    });
    table.appendChild(tb);
    body.appendChild(table);

    modal(def.label + ' columns', body, [
      {
        label: 'Detect again', ghost: true,
        action: function () {
          // Throw away the remembered choices and re-read the headings. The
          // way out of any mapping that has gone stale or wrong.
          src.mapping = S.autoMap(sourceId, src.headers);
          src.knownFields = S.fieldKeys(sourceId);
          global.Store.saveMapping(sourceId, src.headers, src.mapping);
          project(sourceId);
          recompute();
          render();
          U.toast('Columns re-detected from the headings in ' + src.fileName + '.', 'ok');
        }
      },
      { label: 'Cancel', ghost: true },
      {
        label: 'Save mapping', primary: true, action: function () {
          var missing = def.fields.filter(function (f) { return f.required && !working[f.key]; });
          if (missing.length) {
            U.toast('Still need a column for: ' + missing.map(function (f) { return f.label; }).join(', '), 'err');
            return false;
          }
          src.mapping = working;
          src.knownFields = S.fieldKeys(sourceId);
          global.Store.saveMapping(sourceId, src.headers, working);
          project(sourceId);
          recompute();
          render();
          U.toast('Column mapping saved.', 'ok');
        }
      }
    ]);
  }

  /* ==================================================================== */
  /*  tab: dashboard                                                      */
  /* ==================================================================== */

  function renderDashboard(main) {
    var res = state.result;
    var rows = res.rows;
    var flagged = rows.filter(function (r) { return r.issueCount > 0; });
    var high = rows.filter(function (r) { return r.severity === 'high'; });

    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Estate overview'),
      U.el('div', { class: 'sub' }, 'Built from ' + U.num(res.counts.fs) + ' Freshservice rows and ' +
        U.num(res.counts.intune) + ' Intune rows.')
    ]));

    main.appendChild(U.el('div', { class: 'hero' }, [
      U.el('div', {}, [
        U.el('div', { class: 'figure' }, U.num(flagged.length)),
        U.el('div', { class: 'label' }, 'devices with something to correct')
      ]),
      U.el('div', {}, [
        U.el('div', { class: 'label' }, 'out of ' + U.num(rows.length) + ' across both systems (' +
          U.pct(flagged.length, rows.length) + ')'),
        U.el('div', { class: 'detail' }, high.length
          ? U.num(high.length) + ' of them are high severity: a user or location that is wrong, a device one system ' +
            'has never heard of, or an asset marked retired that is still being used.'
          : 'Nothing high severity — the remaining issues are stale data and cosmetic differences.'),
        U.el('button', {
          class: 'btn primary', style: { marginTop: '10px' },
          onclick: function () { setView('attention'); }
        }, 'Open the working list')
      ])
    ]));

    var c = res.counts;
    main.appendChild(U.el('div', { class: 'tiles' }, [
      C.tile('In both systems', c.matched, U.pct(c.matched, c.fs || 1) + ' of Freshservice', function () { setView('clean'); }),
      // Counted from the rule, not from c.fsOnly: printers, switches and phones
      // are legitimately absent from Intune and would inflate the raw figure.
      C.tile('Missing from Intune', res.tally['not-in-intune'] || 0,
        'computers not enrolled or disposed', function () { setView('not-in-intune'); }),
      C.tile('Missing from Freshservice', res.tally['not-in-freshservice'] || 0,
        'agent not reporting', function () { setView('not-in-fs'); }),
      C.tile('User needs fixing', (res.tally['user-mismatch'] || 0) + (res.tally['user-missing-fs'] || 0),
        'can be corrected on import', function () { setView('fix-user'); }),
      C.tile('Location needs fixing', (res.tally['location-missing'] || 0) + (res.tally['location-unknown'] || 0),
        'ask the service', function () { setView('fix-location'); }),
      C.tile('Not checked in', res.tally['stale-intune'] || 0,
        'over ' + state.cfg.staleDays + ' days', function () { setView('stale'); }),
      C.tile('Duplicate rows in the exports', DUPE_SOURCES.reduce(function (a, id) {
        return a + global.Dupes.summarise(dupeGroupsFor(id)).toRemove;
      }, 0), 'same serial more than once', function () { setTab('dupes'); }),
      C.tile('High vulnerability risk', res.tally['high-risk-score'] || 0,
        c.arcticWolf ? 'score ' + state.cfg.riskScoreThreshold + ' or above' : 'load an Arctic Wolf export',
        function () { setView('risk-score'); }),
      C.tile('Moved, by IP address', (res.tally['ip-location-mismatch'] || 0) + (res.tally['ip-suggests-location'] || 0),
        c.subnets ? 'last seen on another site\u2019s network' : 'add IP subnets to the lookup',
        function () { setView('moved-by-ip'); })
    ]));

    if (c.locations && !c.sitesWithSubnet) {
      main.appendChild(U.el('div', { class: 'card' }, [
        U.el('h2', {}, 'No IP subnets in the location lookup'),
        U.el('p', { class: 'hint' },
          'Add an IP subnet column to your location file — one or more ranges per site, as ' +
          '10.20.30.0/24, 10.20.30.*, a range, or several separated by semicolons — and the tool can tell you ' +
          'which devices were last seen on a network belonging to a different site. That is the strongest ' +
          'evidence available that a device has physically moved.')
      ]));
    } else if (c.sitesWithSubnet) {
      var covered = res.rows.filter(function (r) { return r.ip; }).length;
      main.appendChild(U.el('div', { class: 'card' }, [
        U.el('h2', {}, 'IP location checking'),
        U.el('p', { class: 'hint' },
          U.num(c.sitesWithSubnet) + ' of ' + U.num(c.locations) + ' sites have a subnet recorded (' +
          U.num(c.subnets) + ' ranges in total), and ' + U.num(covered) + ' of ' + U.num(res.rows.length) +
          ' devices have a last-seen address to check. ' +
          (res.tally['ip-site-no-subnet']
            ? U.num(res.tally['ip-site-no-subnet']) + ' devices sit at sites with no range recorded.'
            : 'Sites without a range are simply not checked.'))
      ]));
    }

    /* issues by type */
    var issueData = R.RULES
      .filter(function (rule) { return (res.tally[rule.code] || 0) > 0; })
      .map(function (rule) {
        return {
          label: rule.label,
          value: res.tally[rule.code],
          sub: rule.help,
          // Severity is an ordered category, so it gets ordinal steps of the one
          // sequential hue - darkest for the worst - with a legend to say so.
          color: rule.severity === 'high' ? 'var(--seq-700)'
               : rule.severity === 'medium' ? 'var(--seq-400)' : 'var(--seq-250)',
          onClick: function () { state.issueFilter = rule.code; setView('all'); }
        };
      })
      .sort(function (a, b) { return b.value - a.value; });

    var issuesCard = U.el('div', { class: 'card' }, [
      U.el('header', {}, [U.el('h2', {}, 'What is wrong, by type'),
        U.el('span', { class: 'sub' }, 'Click a bar to see those devices')])
    ]);
    var issuesPlot = U.el('div');
    issuesCard.appendChild(issuesPlot);
    main.appendChild(issuesCard);

    /* sites */
    var agg = global.EstateMap.aggregate(rows, { includeOther: false });
    var topSites = agg.sites.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 12)
      .map(function (s) {
        return {
          label: s.name, value: s.count,
          sub: s.issues + ' flagged' + (s.expected !== null ? ' · expected ' + s.expected : ''),
          onClick: function () { state.siteFilter = { key: s.key, name: s.name }; setView('all'); }
        };
      });

    var sitesCard = U.el('div', { class: 'card' }, [
      U.el('header', {}, [U.el('h2', {}, 'Biggest sites by device count'),
        U.el('span', { class: 'sub' }, agg.sites.length ? 'Top 12 of ' + agg.sites.length : '')])
    ]);
    var sitesPlot = U.el('div');
    sitesCard.appendChild(sitesPlot);

    var withExpected = agg.sites.filter(function (s) { return s.variance !== null && s.variance !== 0; });
    var varianceCard = null, variancePlot = null;
    if (withExpected.length) {
      var top = withExpected.slice().sort(function (a, b) { return Math.abs(b.variance) - Math.abs(a.variance); })
        .slice(0, 12).map(function (s) {
          return {
            label: s.name, value: s.variance,
            sub: s.count + ' found, ' + s.expected + ' expected',
            onClick: function () { state.siteFilter = { key: s.key, name: s.name }; setView('all'); }
          };
        });
      varianceCard = U.el('div', { class: 'card' }, [
        U.el('header', {}, [U.el('h2', {}, 'Furthest from expected'),
          U.el('span', { class: 'sub' }, 'Sites to look at first')])
      ]);
      variancePlot = U.el('div');
      varianceCard.appendChild(variancePlot);
      varianceCard._data = top;
    }

    var g = U.el('div', { class: 'grid2' }, [sitesCard, varianceCard]);
    main.appendChild(g);

    if (agg.unlocated.length || agg.unmatched.length) {
      main.appendChild(U.el('div', { class: 'card' }, [
        U.el('h2', {}, 'Not counted against any site'),
        U.el('p', { class: 'hint' }, 'These cannot appear on the map or in a site pack until their location is sorted out.'),
        U.el('div', { class: 'row' }, [
          agg.unlocated.length ? U.el('button', {
            class: 'btn', onclick: function () { state.issueFilter = 'location-missing'; setView('fix-location'); }
          }, U.num(agg.unlocated.length) + ' with no location at all') : null,
          agg.unmatched.length ? U.el('button', {
            class: 'btn', onclick: function () { state.issueFilter = 'location-unknown'; setView('fix-location'); }
          }, U.num(agg.unmatched.reduce(function (a, u) { return a + u.rows.length; }, 0)) +
             ' at ' + agg.unmatched.length + ' locations not in the lookup') : null
        ])
      ]));
    }

    // Charts need their container measured, so draw after layout.
    requestAnimationFrame(function () {
      C.barChart(issuesPlot, issueData, {
        valueLabel: 'Devices', categoryLabel: 'Issue',
        legend: [
          { color: 'var(--seq-700)', label: 'High severity' },
          { color: 'var(--seq-400)', label: 'Medium' },
          { color: 'var(--seq-250)', label: 'Low' }
        ],
        emptyText: 'Nothing flagged at all — the two systems agree.'
      });
      C.barChart(sitesPlot, topSites, {
        valueLabel: 'Devices', categoryLabel: 'Site',
        emptyText: 'No sites yet. Load the location lookup, or check that Freshservice locations are filled in.'
      });
      if (varianceCard) {
        C.divergingBarChart(variancePlot, varianceCard._data, {
          categoryLabel: 'Site', negLabel: 'fewer than expected', posLabel: 'more than expected'
        });
      }
    });
  }

  /* ==================================================================== */
  /*  tab: duplicates within each source file                             */
  /* ==================================================================== */

  var DUPE_SOURCES = ['freshservice', 'intune', 'arcticwolf'];

  function dupeGroupsFor(sourceId) {
    var src = state.sources[sourceId];
    if (!src || !src.records) return [];
    return global.Dupes.findDuplicates(sourceId, src.records, state.cfg.namePrefixes);
  }

  function renderDupes(main) {
    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Duplicate entries in the source files'),
      U.el('div', { class: 'sub' },
        'Rows within one export that describe the same physical machine, matched on serial number. This is about ' +
        'tidying each system, so the lists are per file rather than reconciled together.')
    ]));

    main.appendChild(U.el('div', { class: 'card' }, [
      U.el('h2', {}, 'Build-type prefixes'),
      U.el('p', { class: 'hint' },
        'Where a build names a machine after its serial with a prefix — STD-5CD4092H17, SHR-5CD4092H17 — the ' +
        'serial can be read back out of the name. That is what makes a rebuild under a different build type show ' +
        'up as the duplicate it is, and it is the only way to group Arctic Wolf, which has no serial column at ' +
        'all. Separate prefixes with a vertical bar.'),
      U.el('input', {
        type: 'text', style: { width: '340px' },
        value: state.cfg.namePrefixes,
        onchange: function (e) {
          state.cfg.namePrefixes = e.target.value;
          saveCfg();
        }
      }),
      U.el('div', { class: 'hint', style: { marginTop: '6px' } },
        'A record\u2019s own serial column is always used when it has one; this only fills the gap.')
    ]));

    var anyLoaded = false;

    DUPE_SOURCES.forEach(function (sourceId) {
      var src = state.sources[sourceId];
      if (!src) return;
      anyLoaded = true;

      var def = S.SOURCES[sourceId];
      var groups = dupeGroupsFor(sourceId);
      var sum = global.Dupes.summarise(groups);

      var card = U.el('div', { class: 'card' });
      card.appendChild(U.el('header', {}, [
        U.el('h2', {}, def.label),
        U.el('span', { class: 'sub' }, src.fileName + ' · ' + U.num(src.records.length) + ' rows')
      ]));

      if (!groups.length) {
        var can = global.Dupes.groupable(sourceId, src.records, state.cfg.namePrefixes);
        card.appendChild(U.el('div', { class: 'empty' },
          can.ok ? 'No serial appears more than once in this file.' : can.why));
        main.appendChild(card);
        return;
      }

      card.appendChild(U.el('div', { class: 'tiles', style: { marginBottom: '12px' } }, [
        C.tile('Serials with copies', sum.serials),
        C.tile('Rows to remove', sum.toRemove, 'keeping the most recent of each'),
        C.tile('Need a decision', sum.ambiguous, sum.ambiguous ? 'dates equal or missing' : 'all clear-cut'),
        C.tile('Renamed rebuilds', groups.filter(function (g) { return g.namesDiffer; }).length,
          'same serial, different device name')
      ]));

      card.appendChild(U.el('div', { class: 'row', style: { marginBottom: '12px' } }, [
        U.el('button', {
          class: 'btn primary sm',
          onclick: function () {
            var rows = global.Dupes.exportRows(sourceId, groups, 'remove');
            U.download('duplicates-to-remove-' + sourceId + '-' + U.todayStamp() + '.csv',
              global.CSV.stringify(rows, Object.keys(rows[0])));
            U.toast('Exported ' + U.num(rows.length) + ' rows to remove from ' + def.label + '.', 'ok');
          }
        }, 'Export the ' + U.num(sum.toRemove) + ' to remove'),
        U.el('button', {
          class: 'btn sm',
          onclick: function () {
            var rows = global.Dupes.exportRows(sourceId, groups, 'all');
            U.download('duplicates-all-' + sourceId + '-' + U.todayStamp() + '.csv',
              global.CSV.stringify(rows, Object.keys(rows[0])));
          }
        }, 'Export every copy, keeps included'),
        U.el('span', { class: 'hint' },
          'The removal list keeps the most recent entry for each serial and marks the rest.')
      ]));

      var wrap = U.el('div', { class: 'table-wrap' });
      var t = U.el('table', { class: 'grid' });
      t.appendChild(U.el('thead', {}, U.el('tr', {}, [
        U.el('th', { class: 'nosort' }, 'Serial'),
        U.el('th', { class: 'nosort' }, 'Device name'),
        U.el('th', { class: 'nosort' }, 'Last seen'),
        U.el('th', { class: 'nosort' }, 'Row'),
        U.el('th', { class: 'nosort' }, 'Matched on'),
        U.el('th', { class: 'nosort' }, 'Action')
      ])));
      var tb = U.el('tbody');

      groups.slice(0, 200).forEach(function (g) {
        g.entries.forEach(function (e, i) {
          tb.appendChild(U.el('tr', {}, [
            U.el('td', {}, i === 0
              ? U.el('strong', {}, g.serial)
              : U.el('span', { class: 'muted' }, '')),
            U.el('td', {}, [
              U.el('span', { style: { fontWeight: e.keep ? '600' : '400' } }, e.name || '—'),
              g.namesDiffer && i === 0
                ? U.el('span', { class: 'pill', style: { marginLeft: '6px' } }, 'renamed')
                : null
            ]),
            U.el('td', { class: e.at ? '' : 'muted' },
              e.at ? U.fmtDate(e.at) + ' (' + U.agoLabel(e.at) + ')' : 'no date'),
            U.el('td', { class: 'num muted' }, String(e.row)),
            U.el('td', { class: 'muted' }, e.keyFrom),
            U.el('td', {}, e.keep
              ? U.el('span', { class: 'badge ok' }, [U.el('span', { class: 'sev sev-ok' }), 'Keep'])
              : U.el('span', { class: 'badge ' + (e.ambiguous ? 'medium' : 'high') }, [
                  U.el('span', { class: 'sev sev-' + (e.ambiguous ? 'medium' : 'high') }),
                  e.ambiguous ? 'Check' : 'Remove'
                ]))
          ]));
        });
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      card.appendChild(wrap);

      if (groups.length > 200) {
        card.appendChild(U.el('div', { class: 'hint', style: { marginTop: '8px' } },
          'Showing the first 200 of ' + U.num(groups.length) + ' serials. The exports contain all of them.'));
      }
      main.appendChild(card);
    });

    if (!anyLoaded) {
      main.appendChild(U.el('div', { class: 'card' },
        U.el('div', { class: 'empty' }, 'Load a Freshservice, Intune or Arctic Wolf export to check it for duplicates.')));
    }
  }

  /* ==================================================================== */
  /*  tab: devices                                                        */
  /* ==================================================================== */

  function renderDevices(main) {
    var view = viewById(state.viewId);
    var rows = rowsForView(view);

    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, view.name),
      U.el('div', { class: 'sub' }, view.description || ''),
      state.siteFilter || state.issueFilter ? U.el('div', { class: 'row tight', style: { marginTop: '6px' } }, [
        state.siteFilter ? U.el('span', { class: 'pill' }, 'Site: ' + state.siteFilter.name) : null,
        state.issueFilter ? U.el('span', { class: 'pill' }, 'Issue: ' + ((R.BY_CODE[state.issueFilter] || {}).label || '')) : null,
        U.el('button', {
          class: 'btn sm ghost',
          onclick: function () { state.siteFilter = null; state.issueFilter = null; render(); }
        }, 'Clear filters')
      ]) : null
    ]));

    /* one control row above everything it scopes */
    var controls = U.el('div', { class: 'row no-print', style: { marginBottom: '12px' } });
    var search = U.el('input', {
      type: 'search', placeholder: 'Search these devices…', style: { minWidth: '220px' },
      value: state.viewSearch,
      oninput: U.debounce(function (e) {
        state.viewSearch = e.target.value;
        grid.setSearch(state.viewSearch);
        grid.render();
        renderNoteBar();
      }, 180)
    });
    controls.appendChild(search);

    controls.appendChild(U.el('button', {
      class: 'btn sm', onclick: function () { openColumnPicker(pcCtx(), view, function () { return grid; }); }
    }, 'Columns'));

    controls.appendChild(U.el('button', {
      class: 'btn sm',
      title: view.isCustom ? 'Change this view\u2019s conditions' : 'See how this view is defined, and copy it',
      onclick: function () { openViewBuilder(pcCtx(), view, view.isCustom ? 'edit' : 'inspect'); }
    }, view.isCustom ? 'Edit view' : 'View settings'));

    controls.appendChild(U.el('label', { class: 'check' }, [
      U.el('input', {
        type: 'checkbox', checked: !!view.group,
        onchange: function (e) { grid.setGroup(e.target.checked ? 'location' : null); grid.render(); }
      }),
      'Group by site'
    ]));

    controls.appendChild(U.el('div', { class: 'spacer' }));
    controls.appendChild(U.el('button', {
      class: 'btn sm',
      onclick: function () {
        var visible = grid.visibleRows();
        U.download('view-' + view.id + '-' + U.todayStamp() + '.csv',
          FX.viewCsv(visible, grid.state.columns));
        U.toast('Exported ' + U.num(visible.length) + ' rows.', 'ok');
      }
    }, 'Export this view'));
    controls.appendChild(U.el('button', {
      class: 'btn sm',
      title: 'A sheet per site with blank columns for the service to complete',
      onclick: function () { exportSitePacks(grid.visibleRows()); }
    }, 'Site check sheet'));
    controls.appendChild(U.el('button', {
      class: 'btn sm primary',
      title: 'Build the correction file from the devices you are looking at',
      onclick: function () {
        state.exportScope = state.selectedIds.length ? 'selection' : 'view';
        setTab('export');
      }
    }, 'Build import file'));
    main.appendChild(controls);

    var noteBar = U.el('div', { id: 'notebar', class: 'row no-print', style: { marginBottom: '10px' } });
    main.appendChild(noteBar);

    var gridHost = U.el('div');
    main.appendChild(gridHost);

    renderNoteBar = function () {
      U.clear(noteBar);
      var chosen = grid ? grid.selected() : [];
      var visible = grid ? grid.visibleRows() : [];
      noteBar.appendChild(U.el('button', {
        class: 'btn sm' + (chosen.length ? ' primary' : ''),
        disabled: !chosen.length,
        onclick: function () { openNotes(chosen); }
      }, chosen.length ? 'Add note to ' + U.num(chosen.length) + ' selected' : 'Add note to selected'));
      noteBar.appendChild(U.el('button', {
        class: 'btn sm',
        onclick: function () {
          if (!visible.length) return;
          if (visible.length > 50 &&
              !confirm('Add the same note to all ' + visible.length + ' devices in this view?')) return;
          openNotes(visible);
        }
      }, 'Add note to all ' + U.num(visible.length) + ' in view'));
      noteBar.appendChild(U.el('button', {
        class: 'btn sm ghost',
        onclick: function () {
          visible.forEach(function (r) { grid.state.selection.add(r.id); });
          grid.render(); renderNoteBar();
        }
      }, 'Select all in view'));
      var withNotes = visible.filter(function (r) { return global.Notes.countFor(r); }).length;
      noteBar.appendChild(U.el('span', { class: 'hint' },
        withNotes ? U.num(withNotes) + ' of these have notes' : 'None of these have notes yet'));
      noteBar.appendChild(U.el('div', { class: 'spacer' }));
      noteBar.appendChild(U.el('button', {
        class: 'btn sm ghost',
        title: 'Every note on the devices in this view, one row per note',
        onclick: function () {
          var rows = global.Notes.exportRows(visible);
          if (!rows.length) { U.toast('No notes to export in this view.', 'err'); return; }
          U.download('device-notes-' + U.todayStamp() + '.csv',
            global.CSV.stringify(rows, Object.keys(rows[0])));
        }
      }, 'Export notes'));
    };

    grid = T.create(gridHost, {
      selectable: true,
      pageSize: 150,
      onRowClick: function (r) {
        T.openDrawer(r, null, {
          onAddNote: function (row) { openNotes([row]); }
        });
      },
      onChipClick: function (code) { state.issueFilter = code; render(); },
      onNotesClick: function (r) { openNotes([r]); },
      onSelectionChange: function (sel) {
        state.selectedIds = Array.from(sel);
        renderNoteBar();
      },
      onGroupExport: function (name, members) {
        U.download('site-check-' + slug(name) + '-' + U.todayStamp() + '.csv', FX.sitePackCsv(members, name));
        U.toast('Exported ' + members.length + ' devices for ' + name, 'ok');
      },
      emptyText: 'Nothing in this view. That is good news — or loosen the thresholds in Settings.'
    });
    grid.setRows(rows);
    // The flag has to be present wherever devices are listed, so it is added
    // to whatever columns the view asks for rather than declared per view.
    // A column set the user chose for this view outlives leaving the tab, and
    // the browser session - losing it on every tab switch made the picker feel
    // broken.
    var cols = (state.viewColumnsById[view.id] || view.columns || V.BASE_COLS).slice();
    if (cols.indexOf('notes') < 0) cols.unshift('notes');
    grid.setColumns(cols);
    state.viewColumns = cols;
    grid.setSearch(state.viewSearch);
    state.selectedIds.forEach(function (id) { grid.state.selection.add(id); });
    if (view.sort) grid.setSort(view.sort);
    if (view.group) grid.setGroup(view.group);
    grid.render();
    renderNoteBar();
  }

  /* Read and add notes. One device shows its history; several share one entry,
     written to each with the same timestamp. */
  function openNotes(rows) {
    if (!rows || !rows.length) return;
    var single = rows.length === 1 ? rows[0] : null;

    var body = U.el('div', { class: 'body' });

    var history = U.el('div', { style: { marginBottom: '14px' } });

    function drawHistory() {
      if (!single) return;
      U.clear(history);
      var entries = global.Notes.entriesFor(single);
      if (!entries.length) {
        history.appendChild(U.el('div', { class: 'hint' }, 'No notes on this device yet.'));
        return;
      }
      // Newest first to read, though they are stored in the order written.
      entries.slice().reverse().forEach(function (e) {
        history.appendChild(U.el('div', {
          style: {
            borderLeft: '2px solid var(--accent)', padding: '4px 0 6px 10px',
            marginBottom: '8px'
          }
        }, [
          U.el('div', { class: 'hint' },
            new Date(e.ts).toLocaleString('en-GB') + (e.by ? ' · ' + e.by : '')),
          U.el('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, e.text),
          U.el('button', {
            class: 'btn sm ghost', style: { marginTop: '2px', fontSize: '11px' },
            onclick: function () {
              if (!confirm('Remove this note? The rest of the trail is kept.')) return;
              global.Notes.removeEntry(single, e.ts, e.text);
              drawHistory();
              if (grid) grid.render();
              renderNoteBar();
            }
          }, 'Remove')
        ]));
      });
    }

    if (single) {
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '10px' } },
        single.name + (single.serial ? ' · ' + single.serial : '') +
        (single.location ? ' · ' + single.location : '')));
      drawHistory();
      body.appendChild(history);
    } else {
      body.appendChild(U.el('p', {},
        'This note will be added to ' + U.num(rows.length) + ' devices, each with the same timestamp.'));
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '10px' } },
        rows.slice(0, 6).map(function (r) { return r.name; }).join(', ') +
        (rows.length > 6 ? ' and ' + U.num(rows.length - 6) + ' more' : '')));
    }

    // Asked once, then remembered: without it a shared trail cannot say who
    // did what, which is most of the value when several people work the list.
    var nameBox = null;
    if (!state.author) {
      nameBox = U.el('input', {
        type: 'text', style: { width: '100%' }, placeholder: 'e.g. Scott P',
        value: ''
      });
      body.appendChild(U.el('div', { class: 'field', style: { marginBottom: '12px' } }, [
        U.el('label', {}, 'Your name'),
        nameBox,
        U.el('div', { class: 'hint' },
          'Recorded against the notes you write, so a trail shared with the team says who did what. ' +
          'Asked once; change it in Settings.')
      ]));
    }

    var box = U.el('textarea', {
      rows: 4, style: { width: '100%' },
      placeholder: 'What did you do, or what needs doing? e.g. "Rang Ashfield House, confirmed laptop is with Sarah B, awaiting Freshservice update"'
    });
    body.appendChild(U.el('div', { class: 'field' }, [
      U.el('label', {}, 'Add a note'),
      box
    ]));
    body.appendChild(U.el('div', { class: 'hint', style: { marginTop: '4px' } },
      'Notes are stamped with the date and time and appended to whatever is already there — nothing is ' +
      'overwritten. They are kept in this browser and follow the device by serial number, so they survive ' +
      'loading next month\u2019s exports.'));

    modal(single ? 'Notes — ' + single.name : 'Add a note to ' + U.num(rows.length) + ' devices', body, [
      { label: 'Close', ghost: true },
      {
        label: single ? 'Add note' : 'Add to all ' + U.num(rows.length), primary: true,
        keepOpen: !!single,
        action: function () {
          var text = box.value.trim();
          if (!text) { U.toast('Type the note first.', 'err'); return false; }
          if (nameBox && nameBox.value.trim()) {
            state.author = nameBox.value.trim();
            global.Store.set('author', state.author);
          }
          var res = global.Notes.add(rows, text, state.author);
          if (res.stored === false) {
            U.toast('Note saved for this session, but this browser would not store it — check Settings.', 'err', 9000);
          } else {
            U.toast('Note added to ' + U.num(res.added) + ' device' + (res.added === 1 ? '' : 's') + '.', 'ok');
          }
          // Notes are shared by both populations, so refresh whichever list
          // is on screen — re-rendering only the PC grid left the network
          // flag column stale after a note was added from the Network tab.
          refreshLists();
          // For one device the dialog stays put and shows the entry appended,
          // which is the point of a running trail; a bulk add just closes.
          if (single) { drawHistory(); box.value = ''; box.focus(); }
        }
      }
    ]);
    setTimeout(function () { box.focus(); }, 60);
  }

  /* Redraw whichever device list is currently on screen. */
  function refreshLists() {
    if (state.tab === 'network') {
      if (netGrid) netGrid.render();
      renderNetNoteBar();
    } else {
      if (grid) grid.render();
      renderNoteBar();
    }
  }

  /* The import config lives in two places — localStorage for the settings and
     the working set in IndexedDB — and only recompute() was scheduling the
     working-set save. A value typed into a lookup box therefore reached
     localStorage but not the working set, and on the next visit the stale
     working-set copy overwrote it. Anything that edits the config saves both. */
  function persistNetConfig() {
    global.Store.set('netConfig', state.netConfig);
    saveWorkingSet();
  }

  var previewHook = function () {};

  /* One column picker for both populations: the registry and where the choice
     is remembered come from the context. */
  function openColumnPicker(ctx, view, gridOf) {
    var VE = ctx.views;
    var chosen = gridOf().state.columns.slice();
    var body = U.el('div', { class: 'body' });
    body.appendChild(U.el('p', { class: 'hint' }, 'Pick the columns this view shows. Exports use the same set.'));
    var wrap = U.el('div', { style: { columns: '2', columnGap: '24px' } });
    VE.COLUMNS.forEach(function (col) {
      wrap.appendChild(U.el('label', {
        class: 'check', style: { breakInside: 'avoid', marginBottom: '5px' }
      }, [
        U.el('input', {
          type: 'checkbox', checked: chosen.indexOf(col.key) >= 0,
          onchange: function (e) {
            if (e.target.checked) { if (chosen.indexOf(col.key) < 0) chosen.push(col.key); }
            else chosen = chosen.filter(function (k) { return k !== col.key; });
          }
        }),
        col.label
      ]));
    });
    body.appendChild(wrap);
    modal('Columns', body, [
      {
        label: 'Reset to this view\u2019s columns', ghost: true,
        action: function () {
          delete ctx.columnsById[view.id];
          ctx.saveColumns();
          render();
        }
      },
      { label: 'Cancel', ghost: true },
      { label: 'Apply', primary: true, action: function () {
        // Preserve the canonical column order rather than click order.
        var ordered = VE.COLUMNS.map(function (c) { return c.key; })
          .filter(function (k) { return chosen.indexOf(k) >= 0; });
        var next = ordered.length ? ordered : VE.BASE_COLS.slice();
        if (next.indexOf('notes') < 0) next.unshift('notes');
        var live = gridOf();
        live.setColumns(next);
        if (ctx.key === 'net') state.netColumns = next; else state.viewColumns = next;
        ctx.columnsById[view.id] = next;
        ctx.saveColumns();
        live.render();
      } }
    ]);
  }

  function openSiteOverrides() {
    var body = U.el('div', { class: 'body' });
    var sites = siteIndex();
    var codes = Object.keys(sites).sort();

    body.appendChild(U.el('p', { class: 'hint' },
      'Force a device to a site code. Anything listed here wins over the name and over the ' +
      'firewall it sits under. Names are matched exactly, ignoring case.'));

    if (!codes.length) {
      body.appendChild(U.el('div', { class: 'card', style: { borderColor: 'var(--warn)' } },
        U.el('div', { class: 'hint' },
          'No site list is loaded, so there are no codes to choose from. Drop your site codes file on the Data tab first.')));
    }

    /* Everything the resolver could not place, or placed suspiciously, first —
       that is the list this dialog exists to clear. */
    var suspect = [];
    if (state.netResult) {
      state.netResult.rows.forEach(function (r) {
        if (!r.forti) return;
        var why = !r.siteCode ? 'no site code in the name'
                : (r.forti.siteAgrees === false ? 'resolved to ' + r.siteCode + ' ' + r.siteName + ', which shares no word with the name' : '');
        if (why) suspect.push({ name: r.forti.name, why: why, kind: r.kind, parent: r.parent });
      });
    }

    var draft = Object.assign({}, state.siteOverrides);

    var list = U.el('div', { style: { maxHeight: '46vh', overflow: 'auto' } });

    function codeSelect(name) {
      var sel = U.el('select', {
        onchange: function (e) {
          if (e.target.value) draft[name] = e.target.value;
          else delete draft[name];
        }
      });
      sel.appendChild(U.el('option', { value: '' }, '— leave to the name —'));
      codes.forEach(function (c) {
        sel.appendChild(U.el('option', {
          value: c, selected: (draft[name] || '') === c
        }, c + '  ' + sites[c].name));
      });
      return sel;
    }

    function draw() {
      U.clear(list);
      var rows = U.el('div', { class: 'kv two' });
      rows.appendChild(U.el('div', { class: 'hdr' }, 'Device name'));
      rows.appendChild(U.el('div', { class: 'hdr' }, 'Force to site'));

      // Overrides already set, then the unresolved and suspect ones.
      var shown = {};
      Object.keys(draft).sort().forEach(function (name) {
        shown[name.toLowerCase()] = true;
        rows.appendChild(U.el('div', { class: 'k' }, name));
        rows.appendChild(codeSelect(name));
      });
      suspect.forEach(function (sp) {
        if (shown[sp.name.toLowerCase()]) return;
        shown[sp.name.toLowerCase()] = true;
        rows.appendChild(U.el('div', { class: 'k' }, [
          U.el('div', {}, sp.name),
          U.el('div', { class: 'hint' }, sp.kind + (sp.parent ? ' under ' + sp.parent : '') + ' — ' + sp.why)
        ]));
        rows.appendChild(codeSelect(sp.name));
      });
      list.appendChild(rows);
      if (!Object.keys(draft).length && !suspect.length) {
        list.appendChild(U.el('div', { class: 'empty' },
          'Every device resolved to a site, and none of them looks suspect. Nothing to override.'));
      }
    }
    draw();
    body.appendChild(list);

    var add = U.el('div', { class: 'row', style: { marginTop: '12px' } });
    var nameBox = U.el('input', { type: 'text', placeholder: 'Any other device name…', style: { minWidth: '260px' } });
    add.appendChild(nameBox);
    add.appendChild(U.el('button', {
      class: 'btn sm',
      onclick: function () {
        var v = nameBox.value.trim();
        if (!v) return;
        if (!draft[v]) draft[v] = '';
        nameBox.value = '';
        draw();
      }
    }, 'Add'));
    body.appendChild(add);

    modal('Site overrides', body, [
      { label: 'Cancel', ghost: true },
      { label: 'Save overrides', primary: true, action: function () {
        var clean = {};
        Object.keys(draft).forEach(function (k) { if (draft[k]) clean[k] = draft[k]; });
        state.siteOverrides = clean;
        global.Store.set('siteOverrides', clean);
        recompute();
        render();
        U.toast(Object.keys(clean).length + ' override' + (Object.keys(clean).length === 1 ? '' : 's') + ' saved.', 'ok');
      } }
    ]);
  }


  /* Building the Freshservice import for network kit.

     Nearly all of these rows create a new asset rather than correct one, so
     Workspace, Name, Asset Type and Product all have to be present and — for
     the last three — spelled the way Freshservice spells them. The dialog
     will not export while any of those mappings is unanswered: a wrong
     Product name either fails the import or silently creates a second
     product, and both are worse than being made to fill a box in. */
  function openNetImport() {
    var view = netViewById(state.netViewId);
    var scope = state.netExportScope;
    var rows = (scope === 'selection' ? netSelectedRows() : netRowsForView(view, true))
      .filter(function (r) { return r.forti; });

    var body = U.el('div', { class: 'body' });
    var cfg = state.netConfig;
    var dlg = null;

    var head = U.el('div', { style: { marginBottom: '12px' } });
    body.appendChild(head);

    var scopeRow = U.el('div', { class: 'row', style: { marginBottom: '10px' } });
    [['view', 'Everything in "' + view.name + '"' + (state.netSearch ? ' matching your search' : '')],
     ['selection', U.num(state.netSelectedIds.length) + ' selected']].forEach(function (o) {
      scopeRow.appendChild(U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'radio', name: 'netscope', checked: scope === o[0],
          disabled: o[0] === 'selection' && !state.netSelectedIds.length,
          onchange: function () { state.netExportScope = o[0]; if (dlg) dlg.close(); openNetImport(); }
        }),
        o[1]
      ]));
    });
    body.appendChild(scopeRow);

    /* --- the three lookups ------------------------------------------- */
    var lookupHost = U.el('div');
    body.appendChild(lookupHost);

    function drawLookups() {
      U.clear(lookupHost);
      NX.LOOKUPS.forEach(function (l) {
        var keys = NX.lookupKeys(rows, cfg, l.id);
        if (!keys.length) return;
        var blank = keys.filter(function (k) { return !k.value; }).length;
        var card = U.el('details', { class: 'card', open: blank > 0, style: { marginBottom: '10px' } });
        card.appendChild(U.el('summary', {}, [
          U.el('strong', {}, l.label),
          U.el('span', { class: 'hint', style: { marginLeft: '8px' } },
            blank ? blank + ' of ' + keys.length + ' still to answer'
                  : 'all ' + keys.length + ' mapped')
        ]));
        var kv = U.el('div', { class: 'kv two', style: { marginTop: '8px' } });
        kv.appendChild(U.el('div', { class: 'hdr' }, l.keyLabel));
        kv.appendChild(U.el('div', { class: 'hdr' }, l.valueLabel));
        keys.forEach(function (k) {
          kv.appendChild(U.el('div', { class: 'k' }, [
            U.el('div', {}, k.key + (k.hint ? '  ' + k.hint : '')),
            U.el('div', { class: 'hint' }, U.num(k.count) + ' device' + (k.count === 1 ? '' : 's') +
              ' · e.g. ' + k.examples.slice(0, 2).join(', '))
          ]));
          kv.appendChild(U.el('input', {
            type: 'text', value: k.value, placeholder: 'Freshservice value…',
            style: k.value ? null : { borderColor: 'var(--warn)' },
            oninput: function (e) {
              cfg[l.id][k.key] = e.target.value;
              drawStatus();
            },
            onchange: function () { persistNetConfig(); }
          }));
        });
        card.appendChild(kv);
        if (l.id === 'locations') {
          card.appendChild(U.el('label', { class: 'check', style: { marginTop: '8px' } }, [
            U.el('input', {
              type: 'checkbox', checked: !!cfg.locationFallback,
              onchange: function (e) {
                cfg.locationFallback = e.target.checked;
                persistNetConfig();
                drawLookups(); drawStatus();
              }
            }),
            'Where no Freshservice location is mapped, use the name from my site list'
          ]));
        }
        lookupHost.appendChild(card);
      });
    }

    /* --- columns ------------------------------------------------------ */
    var colCard = U.el('details', { class: 'card', style: { marginBottom: '10px' } });
    colCard.appendChild(U.el('summary', {}, [
      U.el('strong', {}, 'Columns and fixed values'),
      U.el('span', { class: 'hint', style: { marginLeft: '8px' } }, 'headers must match your instance')
    ]));
    var colKv = U.el('div', { class: 'kv two', style: { marginTop: '8px' } });
    colKv.appendChild(U.el('div', { class: 'hdr' }, 'Include'));
    colKv.appendChild(U.el('div', { class: 'hdr' }, 'Header in Freshservice'));
    NX.COLUMNS.forEach(function (col) {
      colKv.appendChild(U.el('div', { class: 'k' }, [
        U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'checkbox', checked: !!cfg.include[col.key], disabled: col.required,
            title: col.required ? 'Freshservice rejects an asset import without this column' : null,
            onchange: function (e) {
              cfg.include[col.key] = e.target.checked;
              persistNetConfig();
              drawLookups(); drawStatus();
            }
          }),
          col.label + (col.required ? ' (required)' : '')
        ]),
        col.fixed ? U.el('div', { class: 'row tight', style: { marginTop: '4px' } }, [
          U.el('span', { class: 'hint' }, 'same on every row:'),
          U.el('input', {
            type: 'text', value: cfg.fixed[col.key] || '', style: { maxWidth: '140px' },
            oninput: function (e) { cfg.fixed[col.key] = e.target.value; drawStatus(); },
            onchange: function () { persistNetConfig(); }
          })
        ]) : null
      ]));
      colKv.appendChild(U.el('input', {
        type: 'text', value: NX.header(col, cfg),
        oninput: function (e) { cfg.headers[col.key] = e.target.value; },
        onchange: function () { persistNetConfig(); drawStatus(); }
      }));
    });
    colCard.appendChild(colKv);
    colCard.appendChild(U.el('label', { class: 'check', style: { marginTop: '8px' } }, [
      U.el('input', {
        type: 'checkbox', checked: !!cfg.describeParent,
        onchange: function (e) {
          cfg.describeParent = e.target.checked;
          persistNetConfig();
          drawStatus();
        }
      }),
      'Record the firewall, HA role, environment and site code in Description'
    ]));
    body.appendChild(colCard);

    /* --- status + preview -------------------------------------------- */
    var status = U.el('div');
    body.appendChild(status);
    var preview = U.el('div', { style: { marginTop: '10px' } });
    body.appendChild(preview);

    var canExport = false;

    function drawStatus() {
      U.clear(status);
      U.clear(preview);
      var un = NX.unmapped(rows, cfg);
      var blanks = NX.blankRequired(rows, cfg);
      var missingCols = NX.missingRequired(cfg);
      canExport = rows.length > 0 && !un.length && !blanks.length && !missingCols.length;

      U.clear(head);
      head.appendChild(U.el('div', { class: 'row tight' }, [
        U.el('strong', {}, U.num(rows.length) + ' device' + (rows.length === 1 ? '' : 's')),
        U.el('span', { class: 'hint' }, 'will be written to the import file')
      ]));

      if (!rows.length) {
        status.appendChild(note('err', 'Nothing to export',
          'This view has no FortiManager-side devices in it. "Possibly replaced" rows exist only in ' +
          'Freshservice, so there is nothing to import for them.'));
      }
      if (missingCols.length) {
        status.appendChild(note('err', 'A required column is switched off',
          missingCols.join(', ') + ' — Freshservice rejects an asset import without it.'));
      }
      if (un.length) {
        var req = un.filter(function (u) { return u.required; });
        status.appendChild(note(req.length ? 'err' : 'warn',
          U.num(un.length) + ' value' + (un.length === 1 ? '' : 's') + ' still to map',
          un.slice(0, 8).map(function (u) {
            return u.key + (u.hint ? ' (' + u.hint + ')' : '') + ' → ' + u.lookupLabel;
          }).join('; ') + (un.length > 8 ? '; and ' + (un.length - 8) + ' more' : '')));
      }
      if (blanks.length) {
        status.appendChild(note('err', 'A required column would be blank',
          blanks.map(function (b) { return b.label + ' on ' + U.num(b.rows) + ' rows'; }).join('; ')));
      }
      if (canExport) {
        var parts = NX.splitByAssetType(rows, cfg);
        status.appendChild(note('ok',
          'Ready \u2014 ' + parts.length + ' file' + (parts.length === 1 ? '' : 's'),
          'Freshservice imports one asset type at a time, so this is written as ' +
          (parts.length === 1 ? 'a single file' : 'one file per type') + ': ' +
          parts.map(function (g) { return g.type + ' (' + U.num(g.rows.length) + ')'; }).join(', ') + '.'));

        // A button per type as well as the lot, because a browser asked for
        // several downloads at once will often prompt about it.
        if (parts.length > 1) {
          var each = U.el('div', { class: 'row tight', style: { margin: '0 0 10px' } });
          each.appendChild(U.el('span', { class: 'hint' }, 'Or one at a time:'));
          parts.forEach(function (g) {
            each.appendChild(U.el('button', {
              class: 'btn sm',
              onclick: function () { downloadPart(g); }
            }, g.type + ' (' + U.num(g.rows.length) + ')'));
          });
          status.appendChild(each);
        }
      }

      // First few lines exactly as they will be written.
      if (rows.length) {
        var firstPart = NX.splitByAssetType(rows, cfg)[0];
        var csv = NX.toImportCsv(firstPart.rows.slice(0, 4), cfg);
        preview.appendChild(U.el('div', { class: 'side-head' },
          'First rows of the ' + firstPart.type + ' file, as they will be written'));
        preview.appendChild(U.el('pre', {
          style: {
            overflowX: 'auto', fontSize: '11px', background: 'var(--surface-2)',
            padding: '8px', border: '1px solid var(--grid)', maxHeight: '150px'
          }
        }, csv));
      }
    }

    function downloadPart(g, quiet) {
      U.download('freshservice-network-import-' + NX.typeSlug(g.type) + '-' + U.todayStamp() + '.csv',
        NX.toImportCsv(g.rows, cfg));
      if (!quiet) {
        U.toast(U.num(g.rows.length) + ' ' + g.type + ' row' + (g.rows.length === 1 ? '' : 's') + ' written.', 'ok');
      }
    }

    function note(kind, title, text) {
      var colour = kind === 'err' ? 'var(--critical)' : kind === 'warn' ? 'var(--warn)' : 'var(--good)';
      return U.el('div', {
        class: 'card',
        style: { borderLeft: '3px solid ' + colour, marginBottom: '8px', padding: '8px 10px' }
      }, [
        U.el('strong', {}, title),
        U.el('div', { class: 'hint' }, text)
      ]);
    }

    drawLookups();
    drawStatus();

    var dlg = modal('Build Freshservice import \u2014 network assets', body, [
      { label: 'Cancel', ghost: true },
      { label: 'Download manifest', ghost: true, action: function () {
        if (!rows.length) { U.toast('Nothing to export.', 'err'); return; }
        U.download('network-import-manifest-' + U.todayStamp() + '.csv', NX.toManifestCsv(rows, cfg));
      } },
      { label: 'Download import files', primary: true, keepOpen: true, action: function () {
        if (!canExport) {
          U.toast('Fill in the highlighted mappings first \u2014 an import missing Product or Asset Type ' +
                  'is rejected by Freshservice.', 'err', 9000);
          return;
        }
        persistNetConfig();
        var parts = NX.splitByAssetType(rows, cfg);
        // Spaced out: a burst of downloads is what browsers block as one.
        parts.forEach(function (g, i) { setTimeout(function () { downloadPart(g, true); }, i * 400); });
        U.toast(parts.length + ' import file' + (parts.length === 1 ? '' : 's') + ' written for ' +
          U.num(rows.length) + ' devices \u2014 one per asset type.', 'ok', 8000);
      } }
    ]);
  }

  function slug(s) {
    return String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'site';
  }

  function exportSitePacks(rows) {
    var groups = U.groupBy(rows, function (r) { return r.location || '(no location)'; });
    if (groups.size === 1) {
      var only = Array.from(groups.keys())[0];
      U.download('site-check-' + slug(only) + '-' + U.todayStamp() + '.csv',
        FX.sitePackCsv(groups.get(only), only));
      U.toast('Exported check sheet for ' + only, 'ok');
      return;
    }
    // One combined file, sorted by site, is easier to handle than N downloads.
    var ordered = [];
    Array.from(groups.keys()).sort().forEach(function (k) {
      ordered = ordered.concat(U.sortBy(groups.get(k), function (r) { return r.name; }));
    });
    U.download('site-check-all-sites-' + U.todayStamp() + '.csv', FX.sitePackCsv(ordered));
    U.toast('Exported ' + U.num(ordered.length) + ' devices across ' + groups.size + ' sites. ' +
            'Use "Group by site" and the per-site button for individual files.', 'ok', 6000);
  }

  /* ==================================================================== */
  /*  tab: map                                                            */
  /* ==================================================================== */


  /* ==================================================================== */
  /*  network assets                                                      */
  /* ==================================================================== */

  var netGrid = null;

  function renderNetwork(main) {
    var view = netViewById(state.netViewId);
    var rows = netRowsForView(view);

    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, view.name),
      U.el('div', { class: 'sub' }, view.description || ''),
      state.netSiteFilter ? U.el('div', { class: 'row tight', style: { marginTop: '6px' } }, [
        U.el('span', { class: 'pill' }, 'Site: ' + state.netSiteFilter.name),
        U.el('button', {
          class: 'btn sm ghost',
          onclick: function () { state.netSiteFilter = null; render(); }
        }, 'Clear filter')
      ]) : null
    ]));

    if (state.netWarnings.length) {
      var warn = U.el('div', { class: 'card', style: { borderColor: 'var(--warn)', marginBottom: '12px' } });
      warn.appendChild(U.el('h3', {}, 'Parsing notes'));
      state.netWarnings.slice(0, 6).forEach(function (w) {
        warn.appendChild(U.el('div', { class: 'hint' }, w.text));
      });
      main.appendChild(warn);
    }

    /* Each tile counts the rows of the view it opens, not the times a rule
       fired. A device can be a duplicate and in both environments at once, so
       adding rule tallies gave a tile a bigger number than the view behind
       it — and a tile you click should land on exactly what it promised. */
    function inView(id) { return netViewCount(netViewById(id)); }
    main.appendChild(U.el('div', { class: 'tiles', style: { marginBottom: '14px' } }, [
      C.tile('New since last import', inView('net-new'),
        'in FortiManager, absent from Freshservice', function () { setNetView('net-new'); }),
      C.tile('Possibly replaced', inView('net-replaced'),
        'in Freshservice, managed by neither', function () { setNetView('net-replaced'); }),
      C.tile('Matched', state.netResult.rows.filter(function (r) { return r.status === 'matched'; }).length,
        'present on both sides'),
      C.tile('Duplicates', inView('net-dupes'),
        'one device, more than one record', function () { setNetView('net-dupes'); }),
      C.tile('Firmware to update', inView('net-firmware'),
        'Freshservice has an older version', function () { setNetView('net-firmware'); }),
      C.tile('Location to fix', inView('net-location'),
        'wrong, missing or unresolved', function () { setNetView('net-location'); })
    ]));

    var controls = U.el('div', { class: 'row no-print', style: { marginBottom: '12px' } });
    controls.appendChild(U.el('input', {
      type: 'search', placeholder: 'Search these devices…', style: { minWidth: '220px' },
      value: state.netSearch,
      oninput: U.debounce(function (e) {
        state.netSearch = e.target.value;
        netGrid.setSearch(state.netSearch);
        netGrid.render();
        renderNetNoteBar();
      }, 180)
    }));
    controls.appendChild(U.el('button', {
      class: 'btn sm', onclick: function () { openColumnPicker(netCtx(), view, function () { return netGrid; }); }
    }, 'Columns'));
    controls.appendChild(U.el('button', {
      class: 'btn sm',
      title: view.isCustom ? 'Change this view\u2019s conditions' : 'See how this view is defined, and copy it',
      onclick: function () { openViewBuilder(netCtx(), view, view.isCustom ? 'edit' : 'inspect'); }
    }, view.isCustom ? 'Edit view' : 'View settings'));
    controls.appendChild(U.el('label', { class: 'check' }, [
      U.el('input', {
        type: 'checkbox', checked: false,
        onchange: function (e) { netGrid.setGroup(e.target.checked ? 'siteName' : null); netGrid.render(); }
      }),
      'Group by site'
    ]));
    controls.appendChild(U.el('div', { class: 'spacer' }));
    controls.appendChild(U.el('button', {
      class: 'btn sm', title: 'Device name → site code, for the handful the name cannot resolve',
      onclick: function () { openSiteOverrides(); }
    }, 'Site overrides'));
    controls.appendChild(U.el('button', {
      class: 'btn sm',
      onclick: function () {
        var visible = netGrid.visibleRows();
        U.download('network-' + view.id + '-' + U.todayStamp() + '.csv',
          netViewCsv(visible, netGrid.state.columns));
        U.toast('Exported ' + U.num(visible.length) + ' rows.', 'ok');
      }
    }, 'Export this view'));
    controls.appendChild(U.el('button', {
      class: 'btn sm primary',
      title: 'Build a Freshservice import from the devices you are looking at',
      onclick: function () {
        state.netExportScope = state.netSelectedIds.length ? 'selection' : 'view';
        openNetImport();
      }
    }, 'Build import file'));
    main.appendChild(controls);

    var noteBar = U.el('div', { class: 'row no-print', style: { marginBottom: '10px' } });
    main.appendChild(noteBar);

    var gridHost = U.el('div');
    main.appendChild(gridHost);

    renderNetNoteBar = function () {
      U.clear(noteBar);
      var chosen = netGrid ? netGrid.selected() : [];
      var visible = netGrid ? netGrid.visibleRows() : [];
      noteBar.appendChild(U.el('button', {
        class: 'btn sm' + (chosen.length ? ' primary' : ''),
        disabled: !chosen.length,
        onclick: function () { openNotes(chosen); }
      }, chosen.length ? 'Add note to ' + U.num(chosen.length) + ' selected' : 'Add note to selected'));
      noteBar.appendChild(U.el('button', {
        class: 'btn sm',
        onclick: function () {
          if (!visible.length) return;
          if (visible.length > 50 &&
              !confirm('Add the same note to all ' + visible.length + ' devices in this view?')) return;
          openNotes(visible);
        }
      }, 'Add note to all ' + U.num(visible.length) + ' in view'));
      noteBar.appendChild(U.el('button', {
        class: 'btn sm ghost',
        onclick: function () {
          visible.forEach(function (r) { netGrid.state.selection.add(r.id); });
          netGrid.render(); renderNetNoteBar();
        }
      }, 'Select all in view'));
      noteBar.appendChild(U.el('div', { class: 'spacer' }));
      noteBar.appendChild(U.el('span', { class: 'hint' },
        U.num(visible.length) + ' of ' + U.num(rows.length) + ' shown'));
    };

    netGrid = T.create(gridHost, {
      views: NV,
      rules: NM,
      selectable: true,
      pageSize: 150,
      onRowClick: function (r) {
        T.openDrawer(r, null, {
          views: NV,
          rules: NM,
          fieldRows: netFieldRows,
          sideLabels: ['FortiManager', 'Freshservice'],
          cleanText: 'Both systems agree on this device.',
          onAddNote: function (row) { openNotes([row]); }
        });
      },
      onChipClick: function (code) { state.netSearch = ''; openNetIssue(code); },
      onNotesClick: function (r) { openNotes([r]); },
      onSelectionChange: function (sel) {
        state.netSelectedIds = Array.from(sel);
        renderNetNoteBar();
      },
      emptyText: 'Nothing in this view.'
    });
    netGrid.setRows(rows);
    var cols = (state.netColumnsById[view.id] || view.columns || NV.BASE_COLS).slice();
    if (cols.indexOf('notes') < 0) cols.unshift('notes');
    netGrid.setColumns(cols);
    state.netColumns = cols;
    netGrid.setSearch(state.netSearch);
    state.netSelectedIds.forEach(function (id) { netGrid.state.selection.add(id); });
    if (view.sort) netGrid.setSort(view.sort);
    netGrid.render();
    renderNetNoteBar();
  }

  var renderNetNoteBar = function () {};

  /* The drawer's side-by-side table for a network device. */
  function netFieldRows(row) {
    var f = row.forti, a = row.fs;
    return [
      ['Device name', f ? f.name : '', a ? a.name : ''],
      ['Serial number', f ? f.serial : '', a ? a.serial : ''],
      ['Type', row.kind, a ? a.assetType : ''],
      ['Vendor', f ? f.vendor : '', a ? a.vendor : ''],
      ['Platform / product', f ? f.platform : '', a ? a.product : ''],
      ['Firmware', f ? f.firmwareText : '', a ? (a.firmwareVersion || a.firmware) : ''],
      ['Location', row.siteName, a ? a.location : ''],
      ['Site code', row.siteCode, '\u2014'],
      ['Asset state', '—', a ? a.state : ''],
      ['Asset tag', '—', a ? a.assetTag : ''],
      ['IP address', f ? f.ipAddress : '', a ? a.ipAddress : ''],
      ['Under firewall', row.parent, '—'],
      ['HA role', row.haRole ? row.haRole + (row.haSync ? ' (' + row.haSync + ')' : '') : '', '—'],
      ['Config status', row.configStatus, '—'],
      ['Environment', row.env ? row.env.split(', ').map(envLabel).join(', ') : '', '—'],
      ['Site resolved from', row.siteSource, '—'],
      ['Last audit', '—', row.lastAudit ? U.fmtDate(row.lastAudit) : ''],
      ['Matched on', row.matchedBy || 'nothing — present in one system only', '—']
    ];
  }

  function openNetIssue(code) {
    var rule = NM.RULE_BY_CODE[code];
    if (!rule) return;
    U.toast(rule.label + (rule.hint ? ' — ' + rule.hint : ''), 'ok', 9000);
  }

  function netViewCsv(rows, columns) {
    var cols = (columns || NV.BASE_COLS).filter(function (k) { return k !== 'notes'; });
    var headers = cols.map(function (k) { return (NV.COL_BY_KEY[k] || {}).label || k; });
    var out = rows.map(function (r) {
      var o = {};
      cols.forEach(function (k, i) {
        var v = NV.colValue(r, k);
        if (Array.isArray(v)) {
          v = v.map(function (c) { return (NM.RULE_BY_CODE[c] || {}).label || c; }).join('; ');
        } else if (v instanceof Date) v = U.fmtDate(v);
        o[headers[i]] = v === null || v === undefined ? '' : v;
      });
      return o;
    });
    return global.CSV.stringify(out, headers);
  }

  function renderMap(main) {
    var M = global.EstateMap;

    // Only offer a population there is data for, and never leave the selector
    // pointing at an empty one.
    var have = { pc: !!state.result, net: !!state.netResult };
    have.both = have.pc && have.net;
    var population = state.mapPopulation;
    if (!have[population]) population = have.pc ? 'pc' : 'net';
    state.mapPopulation = population;

    var agg = M.aggregate({
      pc: state.result ? state.result.rows : [],
      net: state.netResult ? state.netResult.rows : []
    }, { includeOther: state.includeOtherOnMap, population: population });

    var modes = M.modesFor(population);
    if (modes.indexOf(state.mapMode) < 0) state.mapMode = 'count';

    var noun = M.POPULATIONS[population].noun;
    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, population === 'net' ? 'Where the network kit is' : 'Where the devices are'),
      U.el('div', { class: 'sub' },
        'Each dot is a site; the area of the dot is the number of ' + noun + 's recorded there.' +
        (population === 'both' ? ' PCs and network assets are counted together, and the popup splits them out.' : ''))
    ]));

    var controls = U.el('div', { class: 'row no-print', style: { marginBottom: '12px' } }, [
      have.both ? U.el('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, [
        U.el('span', {}, 'Show'),
        U.el('select', {
          onchange: function (e) {
            state.mapPopulation = e.target.value;
            global.Store.set('mapPopulation', state.mapPopulation);
            // A different set of sites means the map should re-fit rather than
            // hold a view framed around the other population.
            M.reset();
            render();
          }
        }, Object.keys(M.POPULATIONS).map(function (k) {
          return U.el('option', { value: k, selected: population === k }, M.POPULATIONS[k].label);
        }))
      ]) : null,
      U.el('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, [
        U.el('span', {}, 'Colour by'),
        U.el('select', {
          onchange: function (e) {
            state.mapMode = e.target.value;
            global.Store.set('mapMode', state.mapMode);
            drawMap(agg);
          }
        }, modes.map(function (k) {
          return U.el('option', { value: k, selected: state.mapMode === k }, M.COLOUR_MODES[k].label);
        }))
      ]),
      population === 'net' ? null : U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: state.includeOtherOnMap,
          onchange: function (e) { state.includeOtherOnMap = e.target.checked; render(); }
        }),
        'Include non-computer assets'
      ]),
      U.el('div', { class: 'spacer' }),
      U.el('button', {
        class: 'btn sm',
        title: 'Look up coordinates for sites that do not have them',
        onclick: function () { openGeocodeModal(); }
      }, 'Find missing coordinates'),
      U.el('button', {
        class: 'btn sm',
        title: 'Save the lookup with any coordinates found, so this is a one-time job',
        onclick: function () {
          var src = state.sources.locations;
          if (!src) { U.toast('No location lookup loaded.', 'err'); return; }
          U.download('location-lookup-with-coordinates-' + U.todayStamp() + '.csv', FX.locationsCsv(src.records));
          U.toast('Saved. Use this file next time and the map draws straight away.', 'ok', 6000);
        }
      }, 'Export lookup')
    ]);
    main.appendChild(controls);

    if (!state.sources.locations) {
      main.appendChild(U.el('div', { class: 'card' }, [
        U.el('h2', {}, 'No location lookup loaded'),
        U.el('p', { class: 'hint' },
          'The map needs a file listing each Freshservice location with its address or postcode. One row per site, ' +
          'with a column for the location name exactly as it appears in Freshservice, and a Postcode or Address ' +
          'column. Latitude and Longitude columns are used directly if you have them; otherwise the tool can look ' +
          'up UK postcodes for you.'),
        U.el('button', { class: 'btn primary', onclick: function () { setTab('data'); } }, 'Go and load it')
      ]));
      return;
    }

    /* The map sits in a shell so the expand control can float over it, and so
       expanding is one class rather than a second layout. */
    var shell = U.el('div', { class: 'map-shell' + (state.mapExpanded ? ' expanded' : '') });
    shell.appendChild(U.el('div', { id: 'map', class: 'card', style: { padding: '0', overflow: 'hidden' } }));
    shell.appendChild(U.el('button', {
      class: 'btn sm map-expand',
      title: state.mapExpanded ? 'Back to the page (Esc)' : 'Fill the window',
      onclick: function () { toggleMapExpanded(); }
    }, state.mapExpanded ? '\u2715  Close' : '\u2921  Expand'));
    main.appendChild(shell);

    var stats = U.el('div', { class: 'tiles', style: { marginTop: '16px' } }, [
      C.tile('Sites on the map', agg.mappable.length),
      C.tile('Sites without coordinates', agg.unmapped.length,
        agg.unmapped.length ? 'add a postcode or run the lookup' : 'all located'),
      C.tile('Locations not in the lookup', agg.unmatched.length,
        agg.unmatched.length ? 'add them to the lookup file' : 'all recognised'),
      C.tile(population === 'net' ? 'Network kit with no site' : 'Devices with no location',
        agg.unlocated.length,
        population === 'net' && agg.unlocated.length ? 'add a site override' : ''),
      population === 'pc' ? null : C.tile('Network kit not in Freshservice',
        agg.mappable.reduce(function (n, s) { return n + s.netMissing; }, 0),
        'across the sites on the map', function () { setNetView('net-new'); })
    ]);
    main.appendChild(stats);

    if (agg.unmapped.length || agg.unmatched.length) {
      var list = U.el('div', { class: 'card' });
      list.appendChild(U.el('h2', {}, 'Sites missing from the map'));
      if (agg.unmapped.length) {
        list.appendChild(U.el('h3', { style: { marginTop: '10px' } }, 'In the lookup, but no coordinates'));
        list.appendChild(U.el('div', { class: 'row tight', style: { marginTop: '6px' } },
          agg.unmapped.slice(0, 40).map(function (s) {
            return U.el('span', { class: 'pill', title: s.address || 'no address in the lookup' },
              s.name + ' (' + s.count + ')');
          })));
      }
      if (agg.unmatched.length) {
        list.appendChild(U.el('h3', { style: { marginTop: '12px' } }, 'Used in Freshservice, but not in the lookup'));
        list.appendChild(U.el('div', { class: 'row tight', style: { marginTop: '6px' } },
          agg.unmatched.slice(0, 40).map(function (u) {
            return U.el('span', { class: 'pill' }, u.name + ' (' + u.rows.length + ')');
          })));
        list.appendChild(U.el('div', { class: 'hint', style: { marginTop: '8px' } },
          'Add these to the location lookup, or correct the location on the assets.'));
      }
      main.appendChild(list);
    }

    requestAnimationFrame(function () { drawMap(agg); });
  }

  /* Expanding is a class on the shell, so Leaflet keeps its layers and its
     pan — it only has to be told the container changed size. */
  function toggleMapExpanded() {
    state.mapExpanded = !state.mapExpanded;
    render();
    global.EstateMap.invalidate();
  }

  function drawMap(agg) {
    global.EstateMap.render('map', agg, {
      mode: state.mapMode,
      population: state.mapPopulation,
      /* The popup says which population its button meant, because a dot on
         the combined map stands for two separate lists. */
      onSelect: function (site, which) {
        if (which === 'net') { setNetSite(site); return; }
        state.siteFilter = { key: site.key, name: site.name };
        setView('all');
      }
    });
  }

  function openGeocodeModal() {
    var src = state.sources.locations;
    if (!src) { U.toast('Load the location lookup first.', 'err'); return; }
    var missing = src.records.filter(function (l) {
      return !(typeof l.lat === 'number' && typeof l.lon === 'number');
    });

    var body = U.el('div', { class: 'body' });
    body.appendChild(U.el('p', {}, U.num(missing.length) + ' of ' + U.num(src.records.length) +
      ' sites have no coordinates.'));
    body.appendChild(U.el('p', { class: 'hint' },
      'UK postcodes are looked up in bulk through postcodes.io, which is free and needs no account. Sites without ' +
      'a usable postcode can be searched by address through OpenStreetMap instead — that one is rate-limited to ' +
      'one site per second, so it takes a while and is off by default.'));
    body.appendChild(U.el('p', { class: 'hint' },
      'Only the address text is sent — never any device or user data. Results are cached in this browser, and you ' +
      'can export the lookup afterwards so it never needs doing again.'));

    var useNom = U.el('input', { type: 'checkbox' });
    body.appendChild(U.el('label', { class: 'check', style: { marginTop: '8px' } },
      [useNom, 'Also search addresses via OpenStreetMap (slower)']));

    var bar = U.el('div', { class: 'progress', style: { marginTop: '14px', display: 'none' } }, U.el('div', { style: { width: '0%' } }));
    var status = U.el('div', { class: 'hint', style: { marginTop: '6px' } }, '');
    body.appendChild(bar);
    body.appendChild(status);

    modal('Find missing coordinates', body, [
      { label: 'Close', ghost: true },
      {
        label: 'Look them up', primary: true, keepOpen: true,
        action: function (btn) {
          btn.disabled = true;
          bar.style.display = '';
          global.Geo.geocodeSites(src.records, function (done, total, msg) {
            bar.firstChild.style.width = total ? Math.round((done / total) * 100) + '%' : '100%';
            status.textContent = msg + ' ' + done + ' of ' + total;
          }, useNom.checked).then(function (res) {
            status.textContent = 'Found ' + res.located + ' of ' + res.total + '.' +
              (res.failed ? ' ' + res.failed + ' could not be located — add a postcode or coordinates by hand.' : '');
            btn.disabled = false;
            global.EstateMap.reset();
            recompute();
            U.toast('Located ' + res.located + ' sites.', 'ok');
            if (state.tab === 'map') render();
          }).catch(function (e) {
            status.textContent = 'Lookup failed: ' + e.message;
            btn.disabled = false;
          });
        }
      }
    ]);
  }

  /* ==================================================================== */
  /*  tab: export                                                         */
  /* ==================================================================== */

  function renderExport(main) {
    var cfg = state.fsConfig;

    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Build the Freshservice import'),
      U.el('div', { class: 'sub' },
        'Choose what to correct and where the correct value comes from. Only rows that would actually change are ' +
        'included, and every proposed change is listed before you download anything.')
    ]));

    var view = viewById(state.viewId);
    var shownRows = rowsForView(view, true);      // exactly what the table showed
    var viewAllRows = rowsForView(view, false);   // the view before the search box
    var picked = selectedRows();

    // A selection that no longer exists (view changed, data reloaded) must not
    // silently export nothing.
    if (state.exportScope === 'selection' && !picked.length) state.exportScope = 'view';

    var scopedRows = state.exportScope === 'selection' ? picked
                   : state.exportScope === 'view' ? shownRows
                   : state.result.rows;

    var proposals = FX.buildProposals(scopedRows, cfg);
    var changeCount = proposals.reduce(function (a, p) { return a + p.changes.length; }, 0);

    /* Which devices the file covers. Getting this wrong is expensive - it is
       the difference between correcting 56 assets and correcting 1,000 - so it
       is stated at the top rather than left implicit, and the view option means
       what was actually on screen, search box included. */
    var scopeCard = U.el('div', { class: 'card' });
    scopeCard.appendChild(U.el('h2', {}, 'Which devices'));

    var narrowed = [];
    if (state.viewSearch) narrowed.push('search "' + state.viewSearch + '"');
    if (state.siteFilter) narrowed.push('site ' + state.siteFilter.name);
    if (state.issueFilter) narrowed.push('issue ' + ((R.BY_CODE[state.issueFilter] || {}).label || ''));

    function scopeOption(value, label, sub) {
      return U.el('div', { style: { marginBottom: '6px' } }, [
        U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'radio', name: 'exportscope', checked: state.exportScope === value,
            onchange: function () { state.exportScope = value; render(); }
          }),
          label
        ]),
        sub ? U.el('div', { class: 'hint', style: { marginLeft: '24px' } }, sub) : null
      ]);
    }

    if (picked.length) {
      scopeCard.appendChild(scopeOption('selection',
        'The ' + U.num(picked.length) + ' devices you ticked',
        'Just the rows you selected on the Devices tab.'));
    }

    scopeCard.appendChild(scopeOption('view',
      'The ' + U.num(shownRows.length) + ' devices shown in ' + view.name,
      narrowed.length
        ? 'Exactly what the table was showing — ' + view.name + ' narrowed by ' + narrowed.join(' and ') +
          ' (' + U.num(shownRows.length) + ' of ' + U.num(viewAllRows.length) + ').'
        : 'The whole of the ' + view.name + ' view; nothing is filtering it further.'));

    scopeCard.appendChild(scopeOption('all',
      'Every device (' + U.num(state.result.rows.length) + ')',
      'The entire reconciled estate, ignoring the view.'));

    main.appendChild(scopeCard);

    /* ------------------------------------------------------ what to fix */
    var setup = U.el('div', { class: 'card' });
    setup.appendChild(U.el('h2', {}, 'What to update'));
    var tbl = U.el('table', { class: 'map-table', style: { marginTop: '10px' } });
    tbl.appendChild(U.el('thead', {}, U.el('tr', {}, [
      U.el('th', {}, 'Field'), U.el('th', {}, 'Take the correct value from'),
      U.el('th', {}, 'Column heading in the import file'), U.el('th', {}, 'Rows')
    ])));
    var tbody = U.el('tbody');

    FX.UPDATABLE.forEach(function (u) {
      var fcfg = cfg.fields[u.field];
      var count = proposals.reduce(function (a, p) {
        return a + p.changes.filter(function (c) { return c.field === u.field; }).length;
      }, 0);

      var sourceSel = U.el('select', {
        disabled: !fcfg.enabled,
        onchange: function (e) { fcfg.source = e.target.value; persistFsConfig(); render(); }
      }, u.sources.map(function (s) {
        return U.el('option', { value: s, selected: fcfg.source === s }, FX.SOURCE_LABELS[s]);
      }));

      var manualBox = u.sources.indexOf('manual') >= 0 && fcfg.source === 'manual'
        ? U.el('input', {
            type: 'text', placeholder: 'e.g. In Use', value: fcfg.manualValue || '',
            style: { marginTop: '4px', width: '100%' },
            onchange: function (e) { fcfg.manualValue = e.target.value; persistFsConfig(); render(); }
          })
        : null;

      /* Which form of the person to write. Freshservice matches a requester on
         their address, so the UPN is what makes the import land on the right
         person - but an instance keyed on display names needs the other. */
      var formBox = u.field === 'user' && fcfg.enabled && fcfg.source === 'intune'
        ? U.el('div', { style: { marginTop: '4px' } }, [
            U.el('select', {
              style: { width: '100%' },
              onchange: function (e) { cfg.userValue = e.target.value; persistFsConfig(); render(); }
            }, [
              U.el('option', { value: 'upn', selected: cfg.userValue !== 'name' },
                'as their email / UPN'),
              U.el('option', { value: 'name', selected: cfg.userValue === 'name' },
                'as their display name')
            ]),
            U.el('div', { class: 'hint' },
              cfg.userValue === 'name'
                ? 'Freshservice usually matches a requester on their address; a display name only works if your instance is set up that way.'
                : 'Falls back to the display name where Intune has no UPN.')
          ])
        : null;

      tbody.appendChild(U.el('tr', {}, [
        U.el('td', {}, U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'checkbox', checked: fcfg.enabled,
            onchange: function (e) { fcfg.enabled = e.target.checked; persistFsConfig(); render(); }
          }),
          u.label
        ])),
        U.el('td', {}, [sourceSel, manualBox, formBox]),
        U.el('td', {}, U.el('input', {
          type: 'text', value: cfg.headers[u.field] || u.field, disabled: !fcfg.enabled,
          onchange: function (e) { cfg.headers[u.field] = e.target.value; persistFsConfig(); }
        })),
        U.el('td', { class: 'num' }, fcfg.enabled ? U.num(count) : '—')
      ]));
    });
    tbl.appendChild(tbody);
    setup.appendChild(tbl);

    setup.appendChild(U.el('div', { class: 'row', style: { marginTop: '14px' } }, [
      U.el('label', { class: 'field' }, [
        U.el('label', {}, 'Match assets on'),
        U.el('select', {
          onchange: function (e) { cfg.matchField = e.target.value; persistFsConfig(); render(); }
        }, [
          U.el('option', { value: 'name', selected: cfg.matchField === 'name' }, 'Device name'),
          U.el('option', { value: 'assetTag', selected: cfg.matchField === 'assetTag' }, 'Asset tag'),
          U.el('option', { value: 'serial', selected: cfg.matchField === 'serial' }, 'Serial number')
        ])
      ]),
      U.el('label', { class: 'field' }, [
        U.el('label', {}, 'Heading for that column'),
        U.el('input', {
          type: 'text', value: cfg.headers[cfg.matchField] || '',
          onchange: function (e) { cfg.headers[cfg.matchField] = e.target.value; persistFsConfig(); }
        })
      ])
    ]));

    setup.appendChild(U.el('div', { class: 'row', style: { marginTop: '12px' } }, [
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: cfg.onlyChanged,
          onchange: function (e) { cfg.onlyChanged = e.target.checked; persistFsConfig(); render(); }
        }), 'Only include rows where the value actually changes'
      ]),
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: cfg.requireIntuneMatch,
          onchange: function (e) { cfg.requireIntuneMatch = e.target.checked; persistFsConfig(); render(); }
        }), 'Only devices confirmed by Intune or a site return'
      ]),
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: cfg.skipRetired,
          onchange: function (e) { cfg.skipRetired = e.target.checked; persistFsConfig(); render(); }
        }), 'Skip assets already marked retired or disposed'
      ]),
      U.el('span', { class: 'hint' }, '(except where the device is still checking in — those are the ones to correct)')
    ]));
    setup.appendChild(U.el('div', { class: 'hint', style: { marginTop: '8px' } },
      'Freshservice matches rows on the column you pick here, so it has to be a field that is filled in and unique ' +
      'on the assets you are updating. Check the headings against your own instance — a custom field will use its ' +
      'own label.'));
    main.appendChild(setup);

    /* ----------------------------------------------- always-on columns */
    var missing = FX.missingRequired(cfg);
    var colCard = U.el('div', { class: 'card' });
    colCard.appendChild(U.el('header', {}, [
      U.el('h2', {}, 'Columns on every row'),
      U.el('span', { class: 'sub' }, 'Required fields and anything else the file should carry')
    ]));
    colCard.appendChild(U.el('p', { class: 'hint' },
      'Freshservice rejects an import that is missing a mandatory field, so these appear on every row whether or ' +
      'not they are what you are correcting. A column takes either a fixed value or the value Freshservice already ' +
      'holds. Where a column names a field you are also correcting, the corrected value is used on the rows that ' +
      'have one and the current value fills the rest, so the column is never blank.'));

    if (missing.length) {
      colCard.appendChild(U.el('div', {
        class: 'badge high', style: { marginBottom: '10px' }
      }, [U.el('span', { class: 'sev sev-high' }),
          'Missing required column' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ')]));
    }

    var colTable = U.el('table', { class: 'map-table' });
    colTable.appendChild(U.el('thead', {}, U.el('tr', {}, [
      U.el('th', { style: { width: '32%' } }, 'Column heading'),
      U.el('th', { style: { width: '34%' } }, 'Value'),
      U.el('th', {}, 'Example from your data'),
      U.el('th', { style: { width: '36px' } }, '')
    ])));
    var colBody = U.el('tbody');
    var sampleRow = scopedRows[0] || state.result.rows[0];

    (cfg.alwaysColumns || []).forEach(function (col, idx) {
      var example = sampleRow ? FX.columnValue(sampleRow, col) : '';
      var blanks = FX.blankCount(proposals, col);

      function optionsFor(group, prefix) {
        return FX.COLUMN_SOURCES[group].map(function (f) {
          return U.el('option', {
            value: prefix + ':' + f.field,
            selected: col.kind === prefix && col.field === f.field
          }, f.label);
        });
      }

      var picker = U.el('select', {
        onchange: function (e) {
          var v = e.target.value;
          if (v === '__fixed') {
            col.kind = 'fixed';
            if (col.value === undefined) col.value = '';
          } else {
            var parts = v.split(':');
            col.kind = parts[0];
            col.field = parts[1];
          }
          persistFsConfig(); render();
        }
      }, [
        U.el('option', { value: '__fixed', selected: col.kind === 'fixed' }, 'Fixed value'),
        U.el('optgroup', { label: 'From Freshservice' }, optionsFor('fs', 'fs')),
        U.el('optgroup', { label: 'From Intune' }, optionsFor('intune', 'intune'))
      ]);

      var valueCell = U.el('td', {}, [
        picker,
        col.kind === 'fixed' ? U.el('input', {
          type: 'text', value: col.value || '', placeholder: 'e.g. IT',
          style: { marginTop: '4px', width: '100%' },
          onchange: function (e) { col.value = e.target.value; persistFsConfig(); render(); }
        }) : null,
        blanks ? U.el('div', {
          class: 'hint', style: { color: 'var(--critical)', marginTop: '3px' }
        }, 'blank on ' + U.num(blanks) + ' of ' + U.num(proposals.length) + ' rows') : null
      ]);

      colBody.appendChild(U.el('tr', {}, [
        U.el('td', {}, U.el('input', {
          type: 'text', value: col.header, style: { width: '100%' },
          onchange: function (e) { col.header = e.target.value; persistFsConfig(); render(); }
        })),
        valueCell,
        U.el('td', { class: 'hint' }, example === '' ? '(blank in Freshservice)' : U.truncate(String(example), 34)),
        U.el('td', {}, U.el('button', {
          class: 'btn sm ghost', title: 'Remove this column',
          onclick: function () { cfg.alwaysColumns.splice(idx, 1); persistFsConfig(); render(); }
        }, '✕'))
      ]));
    });
    colTable.appendChild(colBody);
    colCard.appendChild(colTable);

    var conflicts = FX.columnConflicts(cfg);
    if (conflicts.length) {
      colCard.appendChild(U.el('div', { style: { marginTop: '10px' } }, [
        U.el('span', { class: 'badge medium' }, [U.el('span', { class: 'sev sev-medium' }), 'Correction overridden']),
        U.el('div', { class: 'hint', style: { marginTop: '4px' } },
          conflicts.map(function (c) {
            return '"' + c.header + '" is set to ' + c.source + ', so the correction you switched on for that ' +
                   'field will not reach the file.';
          }).join(' ') +
          ' The column above wins — change its source, or untick the field in "What to update".')
      ]));
    }

    colCard.appendChild(U.el('div', { class: 'row', style: { marginTop: '10px' } }, [
      U.el('button', {
        class: 'btn sm',
        onclick: function () {
          cfg.alwaysColumns.push({ header: '', kind: 'fixed', value: '' });
          persistFsConfig(); render();
        }
      }, '+ Add column'),
      U.el('button', {
        class: 'btn sm ghost',
        title: 'Put back Workspace, Name and Product',
        onclick: function () { cfg.alwaysColumns = FX.defaultAlwaysColumns(); persistFsConfig(); render(); }
      }, 'Reset to the required three')
    ]));
    main.appendChild(colCard);

    /* ------------------------------------------------------- the result */
    var out = U.el('div', { class: 'card' });
    out.appendChild(U.el('header', {}, [
      U.el('h2', {}, 'Proposed changes'),
      U.el('span', { class: 'sub' }, U.num(changeCount) + ' change' + (changeCount === 1 ? '' : 's') +
        ' across ' + U.num(proposals.length) + ' asset' + (proposals.length === 1 ? '' : 's') +
        ', from ' + U.num(scopedRows.length) + ' device' + (scopedRows.length === 1 ? '' : 's') + ' in scope')
    ]));

    out.appendChild(U.el('div', { class: 'row', style: { marginBottom: '12px' } }, [
      U.el('button', {
        class: 'btn primary', disabled: !proposals.length,
        onclick: function () {
          U.download('freshservice-import-' + U.todayStamp() + '.csv',
            FX.toImportCsv(proposals, cfg), 'text/csv', { bom: false });
          U.toast('Import file downloaded. Check a handful of rows before you upload it.', 'ok', 6000);
        }
      }, 'Download import file'),
      U.el('button', {
        class: 'btn', disabled: !proposals.length,
        onclick: function () {
          U.download('freshservice-change-log-' + U.todayStamp() + '.csv', FX.toChangeLogCsv(proposals, cfg));
        }
      }, 'Download change log'),
      U.el('span', { class: 'hint' }, 'The change log records the old value against the new one, for your audit trail.')
    ]));

    if (!proposals.length) {
      // Work out which of the switched-off fields would actually yield changes
      // for these devices, rather than leaving the user to guess.
      var suggestions = [];
      FX.UPDATABLE.forEach(function (u) {
        if (cfg.fields[u.field] && cfg.fields[u.field].enabled) return;
        // Only offer a field some enabled check is actually complaining about.
        // Model and OS differ structurally between the two systems, so with
        // those checks off they are noise, not a suggestion.
        if (!fieldHasLiveRule(u.field)) return;
        var trial = JSON.parse(JSON.stringify(cfg));
        trial.fields[u.field].enabled = true;
        if (u.sources.indexOf('manual') >= 0 && u.field === 'state') {
          trial.fields[u.field].source = 'manual';
          trial.fields[u.field].manualValue = 'In Use';
        }
        var n = FX.buildProposals(scopedRows, trial)
          .reduce(function (a, p) { return a + p.changes.filter(function (c) { return c.field === u.field; }).length; }, 0);
        if (n) suggestions.push({ label: u.label, n: n, field: u.field, weight: fieldWeight(u.field) });
      });

      var empty = U.el('div', { class: 'empty' });
      empty.appendChild(U.el('div', { style: { fontWeight: '600', marginBottom: '6px' } },
        'Nothing to change for these ' + U.num(scopedRows.length) + ' devices with the fields switched on above.'));
      if (suggestions.length) {
        empty.appendChild(U.el('div', {}, 'These would give you something:'));
        var list = U.el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '10px' } });
        // Order by how much the field matters, not by how many rows it touches:
        // a cosmetic OS difference on every device should not outrank the six
        // assets whose recorded state is actually wrong.
        suggestions.sort(function (a, b) {
          return b.weight - a.weight || b.n - a.n;
        }).slice(0, 4).forEach(function (sg) {
          list.appendChild(U.el('button', {
            class: 'btn sm',
            onclick: function () {
              cfg.fields[sg.field].enabled = true;
              if (sg.field === 'state') {
                cfg.fields[sg.field].source = 'manual';
                if (!cfg.fields[sg.field].manualValue) cfg.fields[sg.field].manualValue = 'In Use';
              }
              persistFsConfig(); render();
            }
          }, 'Turn on ' + sg.label + ' (' + U.num(sg.n) + ')'));
        });
        empty.appendChild(list);
      } else {
        empty.appendChild(U.el('div', { class: 'hint' },
          'Freshservice and Intune already agree on every field this tool can correct for these devices. ' +
          'Widen the scope above, or pick a different view.'));
      }
      out.appendChild(empty);
    } else {
      var wrap = U.el('div', { class: 'table-wrap' });
      var t = U.el('table', { class: 'grid' });
      t.appendChild(U.el('thead', {}, U.el('tr', {}, [
        U.el('th', { class: 'nosort' }, 'Device'),
        U.el('th', { class: 'nosort' }, 'Location'),
        U.el('th', { class: 'nosort' }, 'Field'),
        U.el('th', { class: 'nosort' }, 'Currently in Freshservice'),
        U.el('th', { class: 'nosort' }, 'Will become'),
        U.el('th', { class: 'nosort' }, 'Because')
      ])));
      var tb2 = U.el('tbody');
      proposals.slice(0, 500).forEach(function (p) {
        p.changes.forEach(function (c, i) {
          tb2.appendChild(U.el('tr', {
            onclick: function () { T.openDrawer(p.row); }
          }, [
            U.el('td', {}, i === 0 ? U.el('strong', {}, p.row.name) : ''),
            U.el('td', { class: 'muted' }, i === 0 ? (p.row.location || '—') : ''),
            U.el('td', {}, c.label),
            U.el('td', { class: 'muted' }, c.current || '(blank)'),
            U.el('td', {}, U.el('strong', {}, c.proposed)),
            U.el('td', { class: 'muted' }, c.reason || FX.SOURCE_LABELS[c.source])
          ]));
        });
      });
      t.appendChild(tb2);
      wrap.appendChild(t);
      out.appendChild(wrap);
      if (proposals.length > 500) {
        out.appendChild(U.el('div', { class: 'hint', style: { marginTop: '8px' } },
          'Showing the first 500 assets. The downloaded file contains all ' + U.num(proposals.length) + '.'));
      }
    }
    main.appendChild(out);
  }

  function persistFsConfig() { global.Store.set('fsConfig', state.fsConfig); }

  /* How much correcting this field matters, taken from the worst severity of
     the checks that name it as their fix. */
  function fieldWeight(field) {
    var worst = 0;
    R.RULES.forEach(function (rule) {
      if (rule.fix && rule.fix.field === field && R.isEnabled(rule, state.enabledRules)) {
        worst = Math.max(worst, R.SEVERITY_ORDER[rule.severity] || 0);
      }
    });
    return worst;
  }

  function fieldHasLiveRule(field) {
    return R.RULES.some(function (rule) {
      return rule.fix && rule.fix.field === field && R.isEnabled(rule, state.enabledRules);
    });
  }

  /* ==================================================================== */
  /*  tab: settings                                                       */
  /* ==================================================================== */

  function renderSettings(main) {
    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Settings'),
      U.el('div', { class: 'sub' }, 'These are remembered in this browser.')
    ]));

    var thresholds = U.el('div', { class: 'card' });
    thresholds.appendChild(U.el('h2', {}, 'Thresholds'));
    var fields = [
      ['staleDays', 'Days without an Intune check-in before a device counts as stale', 1, 365],
      ['fsStaleDays', 'Days without a Freshservice audit before the record counts as stale', 1, 365],
      ['activeDays', 'Checked in within this many days counts as definitely still in use', 1, 90],
      ['riskScoreThreshold', 'Arctic Wolf risk score at or above which a device is high risk', 0, 10],
      ['risksThreshold', 'Open risks on one device before it counts as a lot', 1, 100000],
      ['scanStaleDays', 'Days without a successful vulnerability scan before it is stale', 1, 365]
    ];
    var grid3 = U.el('div', { class: 'grid3', style: { marginTop: '12px' } });
    fields.forEach(function (f) {
      grid3.appendChild(U.el('div', { class: 'field' }, [
        U.el('label', {}, f[1]),
        U.el('input', {
          type: 'number', min: f[2], max: f[3], value: state.cfg[f[0]],
          step: f[0] === 'riskScoreThreshold' ? '0.1' : '1',
          onchange: function (e) {
            var v = parseFloat(e.target.value);
            if (!isNaN(v)) { state.cfg[f[0]] = v; saveCfg(); }
          }
        })
      ]));
    });
    thresholds.appendChild(grid3);
    main.appendChild(thresholds);

    var matching = U.el('div', { class: 'card' });
    matching.appendChild(U.el('h2', {}, 'Matching'));
    matching.appendChild(U.el('div', { class: 'grid2', style: { marginTop: '12px' } }, [
      U.el('div', { class: 'field' }, [
        U.el('label', {}, 'How to read Freshservice locations'),
        U.el('select', {
          onchange: function (e) { state.cfg.locationStrategy = e.target.value; saveCfg(); }
        }, [
          U.el('option', { value: 'leaf', selected: state.cfg.locationStrategy === 'leaf' }, 'Last part of the path (Region > Site → Site)'),
          U.el('option', { value: 'full', selected: state.cfg.locationStrategy === 'full' }, 'The whole value as written'),
          U.el('option', { value: 'root', selected: state.cfg.locationStrategy === 'root' }, 'First part of the path (Region > Site → Region)')
        ]),
        U.el('div', { class: 'hint' }, 'Use this if your locations are stored as a hierarchy.')
      ]),
      U.el('div', { class: 'field' }, [
        U.el('label', {}, 'Asset types treated as computers'),
        U.el('input', {
          type: 'text', value: state.cfg.computerTypes,
          onchange: function (e) { state.cfg.computerTypes = e.target.value; saveCfg(); }
        }),
        U.el('div', { class: 'hint' },
          'Anything else — network kit, phones, screens — is kept and mapped, but not compared against Intune. ' +
          'Separate alternatives with a vertical bar.')
      ])
    ]));
    matching.appendChild(U.el('div', { class: 'row', style: { marginTop: '10px' } }, [
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: state.cfg.matchOnSerial,
          onchange: function (e) { state.cfg.matchOnSerial = e.target.checked; saveCfg(); }
        }), 'Match on serial number first (recommended)'
      ]),
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: state.cfg.matchOnName,
          onchange: function (e) { state.cfg.matchOnName = e.target.checked; saveCfg(); }
        }), 'Then match on device name'
      ])
    ]));
    main.appendChild(matching);

    var rulesCard = U.el('div', { class: 'card' });
    rulesCard.appendChild(U.el('h2', {}, 'Checks'));
    rulesCard.appendChild(U.el('p', { class: 'hint' }, 'Turn off any check that is not meaningful for your estate.'));
    R.RULES.forEach(function (rule) {
      var on = R.isEnabled(rule, state.enabledRules);
      rulesCard.appendChild(U.el('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--grid)' } }, [
        U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'checkbox', checked: on,
            onchange: function (e) {
              state.enabledRules[rule.code] = e.target.checked;
              global.Store.set('enabledRules', state.enabledRules);
              recompute(); render();
            }
          }),
          U.el('span', { class: 'badge ' + rule.severity }, [U.el('span', { class: 'sev sev-' + rule.severity }), rule.label]),
          state.result ? U.el('span', { class: 'hint' }, U.num(state.result.tally[rule.code] || 0) + ' devices') : null
        ]),
        U.el('div', { class: 'hint', style: { marginLeft: '24px' } }, rule.help)
      ]));
    });
    main.appendChild(rulesCard);

    /* Network assets are reconciled separately, so their checks and thresholds
       are their own. Only shown once there is network data to apply them to. */
    if (state.netResult) {
      var netCard = U.el('div', { class: 'card' });
      netCard.appendChild(U.el('h2', {}, 'Network asset checks'));
      netCard.appendChild(U.el('p', { class: 'hint' },
        'These apply to the FortiManager and Freshservice network exports, not to the PCs.'));

      [['staleAuditDays', 'Days without a Freshservice audit before a network record counts as stale', 30, 1095]]
        .forEach(function (f) {
          netCard.appendChild(U.el('label', { class: 'field' }, [
            U.el('span', {}, f[1]),
            U.el('input', {
              type: 'number', min: String(f[2]), max: String(f[3]), value: String(state.netCfg[f[0]]),
              onchange: function (e) {
                var v = parseInt(e.target.value, 10);
                if (isNaN(v)) return;
                state.netCfg[f[0]] = Math.min(f[3], Math.max(f[2], v));
                global.Store.set('netCfg', state.netCfg);
                recompute(); render();
              }
            })
          ]));
        });

      [['firmwareDrift', 'Report a Freshservice firmware version that no longer matches FortiManager'],
       ['treatUnreportedAsIssue', 'Treat a device that has never reported in as something to look at']]
        .forEach(function (f) {
          netCard.appendChild(U.el('label', { class: 'check', style: { marginTop: '6px' } }, [
            U.el('input', {
              type: 'checkbox', checked: !!state.netCfg[f[0]],
              onchange: function (e) {
                state.netCfg[f[0]] = e.target.checked;
                global.Store.set('netCfg', state.netCfg);
                recompute(); render();
              }
            }),
            f[1]
          ]));
        });

      netCard.appendChild(U.el('div', { class: 'side-head', style: { marginTop: '14px' } }, 'Checks'));
      NM.RULES.forEach(function (rule) {
        netCard.appendChild(U.el('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--grid)' } }, [
          U.el('label', { class: 'check' }, [
            U.el('input', {
              type: 'checkbox', checked: NM.isEnabled(rule, state.netEnabledRules),
              onchange: function (e) {
                state.netEnabledRules[rule.code] = e.target.checked;
                global.Store.set('netEnabledRules', state.netEnabledRules);
                recompute(); render();
              }
            }),
            U.el('span', { class: 'badge ' + rule.severity }, [U.el('span', { class: 'sev sev-' + rule.severity }), rule.label]),
            U.el('span', { class: 'hint' }, U.num(state.netResult.tally[rule.code] || 0) + ' devices')
          ]),
          rule.hint ? U.el('div', { class: 'hint', style: { marginLeft: '24px' } }, rule.hint) : null
        ]));
      });

      netCard.appendChild(U.el('div', { class: 'row', style: { marginTop: '12px' } }, [
        U.el('button', { class: 'btn sm', onclick: function () { openSiteOverrides(); } },
          'Site overrides (' + Object.keys(state.siteOverrides).length + ')'),
        U.el('button', {
          class: 'btn sm ghost',
          title: 'Clear the learned Platform → Product, type and location mappings',
          onclick: function () {
            if (!confirm('Forget the Freshservice Product, Asset Type and Location mappings? ' +
                         'They will be learned again from your Freshservice network export.')) return;
            NX.LOOKUPS.forEach(function (l) { state.netConfig[l.id] = {}; });
            persistNetConfig();
            recompute(); render();
            U.toast('Mappings cleared and re-learned.', 'ok');
          }
        }, 'Reset import mappings')
      ]));
      main.appendChild(netCard);
    }

    var notesCard = U.el('div', { class: 'card' });
    var ns = global.Notes.stats();
    notesCard.appendChild(U.el('h2', {}, 'Device notes'));
    notesCard.appendChild(U.el('p', { class: 'hint' },
      ns.entries
        ? U.num(ns.entries) + ' note' + (ns.entries === 1 ? '' : 's') + ' across ' + U.num(ns.devices) +
          ' device' + (ns.devices === 1 ? '' : 's') + ', using about ' + Math.max(1, Math.round(ns.bytes / 1024)) + ' KB.'
        : 'No notes yet. Add them from the Devices tab — the flag column, or the buttons above the list.'));
    notesCard.appendChild(U.el('p', { class: 'hint' },
      'Notes live in this browser and are matched to a device by serial number, then device name, then asset ' +
      'tag — so they stay attached when you load next month\u2019s exports, and survive a machine being renamed. ' +
      'They are kept separately from the loaded data, so turning off the working-set setting above does not ' +
      'remove them. They travel inside "Save project".'));
    notesCard.appendChild(U.el('div', { class: 'field', style: { maxWidth: '320px', marginBottom: '12px' } }, [
      U.el('label', {}, 'Your name, recorded against notes you write'),
      U.el('input', {
        type: 'text', value: state.author, placeholder: 'e.g. Scott P',
        onchange: function (e) {
          state.author = e.target.value.trim();
          global.Store.set('author', state.author);
          U.toast(state.author ? 'Notes will be signed ' + state.author + '.' : 'Notes will be unsigned.', 'ok');
        }
      })
    ]));

    var whoWrote = global.Notes.authors();
    var authorNames = Object.keys(whoWrote);
    if (authorNames.length) {
      notesCard.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '10px' } },
        'Notes here were written by: ' +
        authorNames.map(function (a) { return a + ' (' + U.num(whoWrote[a]) + ')'; }).join(', ') + '.'));
    }

    notesCard.appendChild(U.el('div', { class: 'row' }, [
      U.el('button', {
        class: 'btn sm', disabled: !ns.entries,
        onclick: function () {
          var rows = state.result ? global.Notes.exportRows(state.result.rows) : [];
          if (!rows.length) { U.toast('Nothing to export.', 'err'); return; }
          U.download('device-notes-all-' + U.todayStamp() + '.csv',
            global.CSV.stringify(rows, Object.keys(rows[0])));
        }
      }, 'Export every note'),
      U.el('button', {
        class: 'btn sm', disabled: !ns.entries,
        onclick: function () {
          if (!confirm('Delete all ' + ns.entries + ' notes? This cannot be undone — export them first if you ' +
                       'need the audit trail.')) return;
          global.Notes.clearAll();
          U.toast('All notes deleted.', 'ok');
          render();
        }
      }, 'Delete all notes')
    ]));
    main.appendChild(notesCard);

    var housekeeping = U.el('div', { class: 'card' });
    housekeeping.appendChild(U.el('h2', {}, 'Stored on this computer'));
    housekeeping.appendChild(U.el('p', { class: 'hint' },
      'The tool keeps your column mappings, thresholds, saved views and geocoding results in this browser' +
      (global.Store.persistent ? '' : ' — except that this browser is blocking storage, so they will be lost when the tab closes') +
      '.'));

    housekeeping.appendChild(U.el('div', { style: { margin: '12px 0', paddingTop: '10px', borderTop: '1px solid var(--grid)' } }, [
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'checkbox', checked: state.persist, disabled: !global.DB.available,
          onchange: function (e) {
            state.persist = e.target.checked;
            global.Store.set('persist', state.persist);
            if (state.persist) { saveWorkingSet(); U.toast('Your loaded data will be here next time.', 'ok'); }
            else { forgetWorkingSet(false); U.toast('Stored data removed. This tab keeps working.', 'ok'); }
            render();
          }
        }),
        U.el('strong', {}, 'Keep the loaded data in this browser between visits')
      ]),
      U.el('div', { class: 'hint', style: { marginLeft: '24px', marginTop: '4px' } },
        global.DB.available
          ? 'On, this stores the device and user rows from your exports on this computer, so closing the tab and ' +
            'coming back tomorrow picks up where you left off. It stays on this machine and in this browser ' +
            'profile — it is not uploaded and other people on other machines cannot see it. Off, the data lives ' +
            'only in the open tab. Either way, "Save project" is there for handing work to someone else.'
          : 'This browser does not allow local databases, so the working set cannot be kept. Use "Save project".'),
      state.savedAt ? U.el('div', { class: 'hint', style: { marginLeft: '24px', marginTop: '4px' } },
        'Last saved ' + state.savedAt.toLocaleString('en-GB')) : null,
      state.persist && global.DB.available ? U.el('button', {
        class: 'btn sm', style: { marginLeft: '24px', marginTop: '8px' },
        onclick: function () {
          if (!confirm('Remove the stored copy? The data stays loaded in this tab until you close it.')) return;
          forgetWorkingSet(false).then(function () { U.toast('Stored copy removed.', 'ok'); });
        }
      }, 'Forget the stored copy now') : null
    ]));
    housekeeping.appendChild(U.el('div', { class: 'row' }, [
      U.el('button', {
        class: 'btn sm', onclick: function () {
          global.Geo.clearCache(); U.toast('Geocoding cache cleared.', 'ok');
        }
      }, 'Clear geocoding cache (' + global.Geo.cacheSize() + ')'),
      U.el('button', {
        class: 'btn sm', onclick: function () {
          if (!confirm('Reset all saved settings, column mappings and custom views?')) return;
          global.Store.clearAll();
          U.toast('Settings cleared. Reloading…', 'ok');
          setTimeout(function () { location.reload(); }, 700);
        }
      }, 'Reset all settings'),
      U.el('button', {
        class: 'btn sm', onclick: function () {
          U.download('asset-reconciler-views.json',
            JSON.stringify({
              views: state.customViews, netViews: state.netCustomViews, favourites: state.favourites,
              fsConfig: state.fsConfig, cfg: state.cfg, netConfig: state.netConfig,
              siteOverrides: state.siteOverrides
            }, null, 2),
            'application/json', { bom: false });
        }
      }, 'Export configuration'),
      U.el('button', { class: 'btn sm', onclick: importConfig }, 'Import configuration')
    ]));
    main.appendChild(housekeeping);
  }

  function saveCfg() {
    global.Store.set('cfg', state.cfg);
    recompute();
    render();
  }

  /* ==================================================================== */
  /*  custom view builder                                                 */
  /* ==================================================================== */

  /* mode: 'new' | 'edit' | 'inspect'
     Built-in views open read-only so their definition can be read and copied;
     a copy is an ordinary custom view and fully editable. */
  /* ------------------------------------------------- population contexts */

  /* The view builder, the sidebar and the column picker are the same job for
     PCs and for network assets: only the column registry, the rule registry
     and where the answer is stored differ. Each population describes itself
     here rather than the UI being written twice. */
  function pcCtx() {
    return {
      key: 'pc',
      label: 'Device views',
      noun: 'device',
      listName: 'device list',
      tab: 'devices',
      views: V,
      rules: R,
      result: state.result,
      builtIn: V.BUILT_IN,
      custom: state.customViews,
      saveCustom: function (list) {
        state.customViews = list;
        global.Store.set('customViews', list);
      },
      columnsById: state.viewColumnsById,
      saveColumns: function () { global.Store.set('viewColumns', state.viewColumnsById); },
      all: allViews,
      count: viewCount,
      currentId: function () { return state.viewId; },
      isActive: function () { return state.tab === 'devices'; },
      open: setView,
      fallbackId: 'attention',
      codeDrivenHelp: 'This view is built from a rule in code rather than from conditions \u2014 it lists ' +
        'Freshservice assets whose type is outside the computer types in Settings. A copy would not reproduce ' +
        'it, so copying is disabled.'
    };
  }

  function netCtx() {
    return {
      key: 'net',
      label: 'Network views',
      noun: 'network device',
      listName: 'network list',
      tab: 'network',
      views: NV,
      rules: NM,
      result: state.netResult,
      builtIn: NV.BUILT_IN,
      custom: state.netCustomViews,
      saveCustom: function (list) {
        state.netCustomViews = list;
        global.Store.set('netCustomViews', list);
      },
      columnsById: state.netColumnsById,
      saveColumns: function () { global.Store.set('netColumns', state.netColumnsById); },
      all: netViews,
      count: netViewCount,
      currentId: function () { return state.netViewId; },
      isActive: function () { return state.tab === 'network'; },
      open: setNetView,
      fallbackId: 'net-new'
    };
  }

  function ctxFor(key) { return key === 'net' ? netCtx() : pcCtx(); }

  function openViewBuilder(ctx, existing, mode) {
    var VE = ctx.views, RE = ctx.rules;
    mode = mode || (existing ? 'edit' : 'new');
    var readOnly = mode === 'inspect';
    // Drop any hook left by a previous dialog before this one wires its own.
    previewHook = function () {};

    function blankDraft() {
      return {
        id: 'custom-' + Date.now().toString(36),
        name: '',
        description: '',
        columns: VE.BASE_COLS.slice(),
        filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] }
      };
    }

    var draft;
    if (existing) {
      draft = {
        id: existing.id,
        name: existing.name,
        description: existing.description || '',
        columns: (ctx.columnsById[existing.id] || existing.columns || VE.BASE_COLS).slice(),
        filter: existing.filter
          ? JSON.parse(JSON.stringify(existing.filter))
          : { match: 'all', conditions: [] }
      };
    } else {
      draft = blankDraft();
    }

    // Two built-ins cannot be expressed as conditions: one has no filter at all
    // and one is driven by code. Say so rather than showing an empty box that
    // implies the view matches everything.
    var codeDriven = !!(existing && existing.custom);
    var unfiltered = !!(existing && !existing.custom && !existing.filter);

    var body = U.el('div', { class: 'body' });

    if (readOnly) {
      body.appendChild(U.el('div', { class: 'row tight', style: { marginBottom: '12px' } }, [
        U.el('span', { class: 'badge low' }, 'Built-in view'),
        U.el('span', { class: 'hint' },
          'Shown as it is defined. Use "Save as a copy" to get an editable version.')
      ]));
    }
    if (codeDriven) {
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '12px', color: 'var(--critical)' } },
        ctx.codeDrivenHelp || 'This view is built from a rule in code rather than from conditions, so a copy ' +
        'would not reproduce it and copying is disabled.'));
    } else if (unfiltered) {
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '12px' } },
        'This view has no conditions: it lists every reconciled ' + ctx.noun + '. A copy starts from that and ' +
        'you can add conditions to narrow it.'));
    }
    body.appendChild(U.el('div', { class: 'field', style: { marginBottom: '12px' } }, [
      U.el('label', {}, 'View name'),
      U.el('input', { type: 'text', value: draft.name, placeholder: 'e.g. North region, no user set',
        oninput: function (e) { draft.name = e.target.value; } })
    ]));
    body.appendChild(U.el('div', { class: 'field', style: { marginBottom: '16px' } }, [
      U.el('label', {}, 'Description shown to whoever opens it'),
      U.el('input', { type: 'text', value: draft.description, placeholder: 'What this list is for',
        oninput: function (e) { draft.description = e.target.value; } })
    ]));

    body.appendChild(U.el('div', { class: 'row', style: { marginBottom: '10px' } }, [
      U.el('span', {}, 'Show ' + ctx.noun + 's where'),
      U.el('select', {
        onchange: function (e) { draft.filter.match = e.target.value; }
      }, [
        U.el('option', { value: 'all', selected: draft.filter.match === 'all' }, 'all of these are true'),
        U.el('option', { value: 'any', selected: draft.filter.match === 'any' }, 'any of these are true')
      ])
    ]));

    var condHost = U.el('div');
    body.appendChild(condHost);

    function fieldOptions(selected) {
      var opts = [
        U.el('option', { value: '__anyIssue', selected: selected === '__anyIssue' }, 'Has any issue'),
        U.el('option', { value: '__issue', selected: selected === '__issue' }, 'Has a specific issue')
      ];
      VE.COLUMNS.forEach(function (c) {
        opts.push(U.el('option', { value: c.key, selected: selected === c.key }, c.label));
      });
      return opts;
    }

    function drawConditions() {
      U.clear(condHost);
      draft.filter.conditions.forEach(function (cond, idx) {
        var isIssue = cond.field === '__issue';
        var isAny = cond.field === '__anyIssue';

        var valueControl;
        if (isIssue) {
          valueControl = U.el('select', {
            onchange: function (e) { cond.value = e.target.value; previewHook(); }
          }, RE.RULES.map(function (rule) {
            return U.el('option', { value: rule.code, selected: cond.value === rule.code }, rule.label);
          }));
        } else if (isAny) {
          valueControl = U.el('span', { class: 'hint' }, '');
        } else {
          var opDef = VE.OPERATORS.filter(function (o) { return o.op === cond.op; })[0];
          valueControl = (opDef && opDef.needsValue === false)
            ? U.el('span', { class: 'hint' }, '')
            : U.el('input', {
                type: opDef && opDef.numeric ? 'number' : 'text',
                value: cond.value === undefined ? '' : cond.value,
                placeholder: 'value',
                oninput: function (e) { cond.value = e.target.value; previewHook(); }
              });
        }

        var opControl = isAny
          ? U.el('select', { onchange: function (e) { cond.op = e.target.value; } }, [
              U.el('option', { value: 'is', selected: cond.op === 'is' }, 'yes'),
              U.el('option', { value: 'isNot', selected: cond.op === 'isNot' }, 'no')
            ])
          : isIssue
            ? U.el('select', { onchange: function (e) { cond.op = e.target.value; } }, [
                U.el('option', { value: 'is', selected: cond.op === 'is' }, 'is present'),
                U.el('option', { value: 'isNot', selected: cond.op === 'isNot' }, 'is not present')
              ])
            : U.el('select', {
                onchange: function (e) { cond.op = e.target.value; drawConditions(); }
              }, VE.OPERATORS.map(function (o) {
                return U.el('option', { value: o.op, selected: cond.op === o.op }, o.label);
              }));

        condHost.appendChild(U.el('div', { class: 'cond-row' }, [
          U.el('select', {
            onchange: function (e) {
              cond.field = e.target.value;
              cond.op = 'is';
              cond.value = cond.field === '__issue' ? RE.RULES[0].code : '';
              drawConditions();
            }
          }, fieldOptions(cond.field)),
          opControl,
          valueControl,
          U.el('button', {
            class: 'btn sm ghost', title: 'Remove this condition',
            onclick: function () { draft.filter.conditions.splice(idx, 1); drawConditions(); }
          }, '✕')
        ]));
      });
      condHost.appendChild(U.el('button', {
        class: 'btn sm', style: { marginTop: '4px' },
        onclick: function () {
          draft.filter.conditions.push({ field: 'location', op: 'contains', value: '' });
          drawConditions();
        }
      }, '+ Add condition'));
      previewHook();
    }
    drawConditions();

    var preview = U.el('div', { class: 'hint', style: { marginTop: '14px' } });
    function updatePreview() {
      if (!ctx.result) { preview.textContent = ''; return; }
      if (codeDriven) {
        preview.textContent = 'Matches ' + U.num(VE.applyView(existing, ctx.result.rows).length) + ' ' + ctx.noun + 's.';
        return;
      }
      var n = ctx.result.rows.filter(function (r) { return VE.testFilter(r, draft.filter); }).length;
      preview.textContent = U.num(n) + ' of ' + U.num(ctx.result.rows.length) + ' ' + ctx.noun + 's match right now.';
    }
    previewHook = updatePreview;      // called whenever a condition changes
    body.appendChild(preview);
    updatePreview();

    body.appendChild(U.el('div', { class: 'hint', style: { marginTop: '10px' } },
      'Which columns this view shows is set with the Columns button on the ' + ctx.listName + ', and is remembered ' +
      'per view.'));

    function saveDraft(asCopy) {
      if (asCopy) {
        draft.id = 'custom-' + Date.now().toString(36);
        if (!/copy/i.test(draft.name)) draft.name = draft.name + ' (copy)';
      }
      if (!draft.name.trim()) { U.toast('Give the view a name.', 'err'); return false; }
      draft.filter.conditions = (draft.filter.conditions || []).filter(function (c) { return c.field; });
      ctx.saveCustom(ctx.custom.filter(function (v) { return v.id !== draft.id; }).concat([draft]));
      if (asCopy) {
        // Carry the original's columns onto the copy so it looks the same.
        ctx.columnsById[draft.id] = draft.columns.slice();
        ctx.saveColumns();
      }
      ctx.open(draft.id);
      U.toast(asCopy ? 'Copied to "' + draft.name + '" — edit it freely.'
                     : 'View updated.', 'ok', 6000);
    }

    var buttons = [{ label: readOnly ? 'Close' : 'Cancel', ghost: true }];
    if (readOnly) {
      buttons.push({
        label: 'Save as a copy', primary: true,
        action: function () {
          if (codeDriven) { U.toast('This view cannot be copied — its rule lives in code.', 'err'); return false; }
          return saveDraft(true);
        }
      });
    } else {
      buttons.push({
        label: mode === 'edit' ? 'Save changes' : 'Save view', primary: true,
        action: function () { return saveDraft(false); }
      });
    }

    modal(mode === 'inspect' ? 'View settings — ' + draft.name
        : mode === 'edit' ? 'Edit view — ' + draft.name
        : 'New view', body, buttons);

    if (readOnly) {
      // Everything in the body is for reading; the footer still works.
      U.qsa('input, select, textarea, button', body).forEach(function (el) { el.disabled = true; });
    }
  }
  function importConfig() {
    var input = U.el('input', {
      type: 'file', accept: '.json', style: { display: 'none' },
      onchange: function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var json = JSON.parse(String(fr.result).replace(/^\uFEFF/, ''));
            if (json.views) {
              state.customViews = json.views;
              global.Store.set('customViews', state.customViews);
            }
            if (json.netViews) {
              state.netCustomViews = json.netViews;
              global.Store.set('netCustomViews', state.netCustomViews);
            }
            if (json.favourites) {
              state.favourites = json.favourites;
              global.Store.set('favourites', state.favourites);
            }
            if (json.netConfig) { state.netConfig = mergeNetConfig(json.netConfig); persistNetConfig(); }
            if (json.siteOverrides) {
              state.siteOverrides = json.siteOverrides;
              global.Store.set('siteOverrides', state.siteOverrides);
            }
            if (json.cfg) { state.cfg = global.Match.settings(json.cfg); global.Store.set('cfg', state.cfg); }
            if (json.fsConfig) { state.fsConfig = mergeFsConfig(json.fsConfig); persistFsConfig(); }
            recompute(); render();
            U.toast('Configuration imported.', 'ok');
          } catch (err) {
            U.toast('That file could not be read as a configuration export.', 'err');
          }
        };
        fr.readAsText(f);
      }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { if (input.parentNode) input.parentNode.removeChild(input); }, 1000);
  }

  /* ==================================================================== */
  /*  project save / open                                                 */
  /* ==================================================================== */

  function saveProject() {
    if (!Object.keys(state.sources).length) { U.toast('Nothing loaded to save.', 'err'); return; }
    var payload = {
      format: 'asset-reconciler-project',
      version: 1,
      savedAt: new Date().toISOString(),
      savedBy: state.author || '',
      cfg: state.cfg,
      enabledRules: state.enabledRules,
      customViews: state.customViews,
      fsConfig: state.fsConfig,
      notes: global.Notes.snapshot(),
      sources: {}
    };
    SOURCE_IDS.forEach(function (id) {
      var s = state.sources[id];
      if (!s) return;
      payload.sources[id] = { fileName: s.fileName, headers: s.headers, mapping: s.mapping, raw: s.raw };
    });
    U.download('asset-reconciler-' + U.todayStamp() + '.json', JSON.stringify(payload, null, 1),
      'application/json', { bom: false });
    U.toast('Project saved. It contains your device data, so keep it somewhere appropriate.', 'ok', 7000);
  }

  function openProject() {
    var input = U.el('input', {
      type: 'file', accept: '.json', style: { display: 'none' },
      onchange: function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            // Strip a leading BOM: files written by an earlier build carry one,
            // and JSON.parse treats it as a syntax error.
            var p = JSON.parse(String(fr.result).replace(/^\uFEFF/, ''));
            if (p.format !== 'asset-reconciler-project') throw new Error('not a project file');
            state.sources = {};
            Object.keys(p.sources || {}).forEach(function (id) {
              var s = p.sources[id];
              state.sources[id] = { id: id, fileName: s.fileName, headers: s.headers, mapping: s.mapping, raw: s.raw };
              project(id);
            });
            if (p.cfg) state.cfg = global.Match.settings(p.cfg);
            if (p.enabledRules) state.enabledRules = p.enabledRules;
            if (p.customViews) state.customViews = p.customViews;
            if (p.fsConfig) state.fsConfig = mergeFsConfig(p.fsConfig);
            // Merge rather than replace: notes already written in this browser
            // are somebody's work and must not be dropped by opening a file.
            var mergeReport = p.notes ? global.Notes.merge(p.notes) : null;
            global.EstateMap.reset();
            recompute();
            setTab('dashboard');
            var who = p.savedBy ? ' saved by ' + p.savedBy : '';
            var when = p.savedAt ? ' on ' + new Date(p.savedAt).toLocaleString('en-GB') : '';
            U.toast('Loaded ' + f.name + who + when + '.', 'ok', 7000);
            if (mergeReport && (mergeReport.added || mergeReport.skipped)) {
              U.toast('Notes merged: ' + U.num(mergeReport.added) + ' added' +
                (mergeReport.newDevices ? ' (' + U.num(mergeReport.newDevices) + ' devices new to this browser)' : '') +
                ', ' + U.num(mergeReport.skipped) + ' already here. Nothing of yours was replaced.', 'ok', 10000);
            }
          } catch (err) {
            U.toast('That is not an Asset Reconciler project file.', 'err');
          }
        };
        fr.readAsText(f);
      }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { if (input.parentNode) input.parentNode.removeChild(input); }, 1000);
  }

  function loadSample() {
    if (!global.SampleData) { U.toast('Sample data is not available in this build.', 'err'); return; }
    Object.keys(global.SampleData).forEach(function (id) {
      var parsed = global.CSV.parse(global.SampleData[id]);
      state.sources[id] = {
        id: id,
        fileName: 'sample-' + id + '.csv',
        headers: parsed.headers,
        raw: parsed.rows,
        mapping: S.autoMap(id, parsed.headers),
        autoMapped: true
      };
      project(id);
    });
    global.EstateMap.reset();
    recompute();
    setTab('dashboard');
    U.toast('Sample data loaded. Nothing here is real.', 'ok');
  }

  /* ==================================================================== */
  /*  modal helper                                                        */
  /* ==================================================================== */

  function modal(title, bodyEl, buttons, opts) {
    opts = opts || {};
    var back = U.el('div', { class: 'modal-back' });
    function close() {
      if (back.parentNode) document.body.removeChild(back);
      document.removeEventListener('keydown', esc);
    }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });

    var m = U.el('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    m.appendChild(U.el('header', {}, [
      U.el('h2', {}, title),
      U.el('div', { class: 'spacer' }),
      U.el('button', { class: 'btn sm ghost', onclick: close, 'aria-label': 'Close' }, '✕')
    ]));
    m.appendChild(bodyEl);

    var foot = U.el('footer', {});
    foot.appendChild(U.el('div', { class: 'spacer' }));
    (buttons || []).forEach(function (b) {
      var btn = U.el('button', {
        class: 'btn' + (b.primary ? ' primary' : b.ghost ? ' ghost' : ''),
        onclick: function () {
          if (!b.action) { close(); return; }
          var r = b.action(btn);
          if (r !== false && !b.keepOpen) close();
        }
      }, b.label);
      foot.appendChild(btn);
    });
    m.appendChild(foot);
    back.appendChild(m);
    document.body.appendChild(back);
    return { close: close };
  }

  /* ==================================================================== */
  /*  boot                                                                */
  /* ==================================================================== */

  function init() {
    // Escape is the way out of anything full-screen; the modals already use it.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.mapExpanded && !U.qs('.modal-back')) {
        toggleMapExpanded();
      }
    });

    // The network table shows the name you gave each FortiManager export
    // rather than its file name.
    NV.setEnvLabeller(envLabel);
    NX.setEnvLabeller(envLabel);

    var theme = global.Store.get('theme', null);
    if (theme) document.documentElement.setAttribute('data-theme', theme);

    // Dropping a file anywhere in the window loads it.
    ['dragover', 'drop'].forEach(function (evt) {
      window.addEventListener(evt, function (e) {
        if (e.target.closest && e.target.closest('.drop')) return;
        e.preventDefault();
        if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
          loadFiles(e.dataTransfer.files);
        }
      });
    });

    window.addEventListener('resize', U.debounce(function () {
      if (state.tab === 'dashboard') render();
      if (state.tab === 'map') global.EstateMap.invalidate();
    }, 250));

    // Render the empty shell straight away, then bring back the previous
    // working set - IndexedDB is asynchronous, so waiting on it would leave
    // the page blank.
    render();
    restoreWorkingSet().then(function (restored) {
      if (!restored) return;
      /* Land on a tab the restored data can actually fill. A session with only
         the network exports in it has no PC reconciliation, and the Dashboard
         reads that result unconditionally. */
      setTab(state.result ? 'dashboard' : (state.netResult ? 'network' : 'data'));
      U.toast('Picked up where you left off — ' +
        Object.keys(state.sources).map(function (id) {
          return S.SOURCES[id].short + ' ' + U.num(state.sources[id].records.length);
        }).join(', ') +
        (state.restoredAt ? ', saved ' + U.fmtDate(state.restoredAt) : ''), 'ok', 7000);

      // The tool has gained fields since this working set was stored; say which
      // ones are now populated rather than leaving them to be noticed.
      (state.restoredFills || []).forEach(function (r) {
        U.toast(S.SOURCES[r.source].label + ': ' + r.filled.length + ' column' +
          (r.filled.length === 1 ? '' : 's') + ' added since you loaded this file are now matched — ' +
          r.filled.map(function (x) { return x.label; }).join(', ') + '.', 'ok', 12000);
      });
    });
  }

  global.App = { init: init, state: state, render: render, loadSample: loadSample, recompute: recompute };
})(window);

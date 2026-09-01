/* Application controller: state, the tab views, and everything that wires the
   modules together. */
(function (global) {
  'use strict';

  var U = global.U, V = global.Views, R = global.Rules, N = global.Norm,
      S = global.Schema, C = global.Charts, T = global.Table, FX = global.FSExport;

  var SOURCE_IDS = ['freshservice', 'intune', 'locations', 'verification'];

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
    restoredAt: null
  };

  var grid = null;
  var renderNoteBar = function () {};

  /* ==================================================================== */
  /*  data loading                                                        */
  /* ==================================================================== */

  function loadFiles(files, forcedSource) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;

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
        var mapping = saved || S.autoMap(sourceId, parsed.headers);

        state.sources[sourceId] = {
          id: sourceId,
          fileName: file.name,
          headers: parsed.headers,
          raw: parsed.rows,
          mapping: mapping,
          autoMapped: !saved,
          loadedAt: new Date()
        };
        project(sourceId);
        return { sourceId: sourceId, file: file.name, rows: parsed.rows.length };
      });
    });

    Promise.all(jobs).then(function (results) {
      results.forEach(function (r) {
        U.toast(S.SOURCES[r.sourceId].label + ': ' + U.num(r.rows) + ' rows from ' + r.file, 'ok');
      });
      recompute();
      if (state.tab === 'data') render();
      var missing = SOURCE_IDS.filter(function (id) { return !state.sources[id]; });
      if (!missing.length || (state.sources.freshservice && state.sources.intune)) {
        if (state.tab === 'data') setTab('dashboard');
      }
    }).catch(function (err) {
      U.toast(err.message || String(err), 'err', 8000);
      render();
    });
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
      return;
    }
    state.result = R.apply(global.Match.reconcile(data, state.cfg), state.cfg, state.enabledRules);
    saveWorkingSet();
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
      sources: {}
    };
    SOURCE_IDS.forEach(function (id) {
      var src = state.sources[id];
      if (!src) return;
      payload.sources[id] = {
        fileName: src.fileName, headers: src.headers,
        mapping: src.mapping, raw: src.raw
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
    return global.DB.load().then(function (payload) {
      if (!payload || !payload.sources || !Object.keys(payload.sources).length) return false;
      Object.keys(payload.sources).forEach(function (id) {
        var src = payload.sources[id];
        if (!src || !src.raw) return;
        state.sources[id] = {
          id: id, fileName: src.fileName, headers: src.headers,
          mapping: src.mapping, raw: src.raw
        };
        project(id);
      });
      if (payload.cfg) state.cfg = global.Match.settings(payload.cfg);
      if (payload.enabledRules) state.enabledRules = payload.enabledRules;
      if (payload.customViews) state.customViews = payload.customViews;
      if (payload.fsConfig) state.fsConfig = mergeFsConfig(payload.fsConfig);
      state.restoredAt = payload.savedAt ? new Date(payload.savedAt) : null;
      state.savedAt = state.restoredAt;
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
      ['devices', 'Devices'],
      ['map', 'Map'],
      ['export', 'Freshservice import'],
      ['settings', 'Settings']
    ];
    tabs.forEach(function (t) {
      var disabled = !state.result && t[0] !== 'data' && t[0] !== 'settings';
      host.appendChild(U.el('button', {
        class: 'tab' + (state.tab === t[0] ? ' active' : ''),
        disabled: disabled,
        style: disabled ? { opacity: '0.4', cursor: 'not-allowed' } : null,
        onclick: function () { if (!disabled) setTab(t[0]); }
      }, t[1]));
    });

    host.appendChild(U.el('div', { class: 'spacer' }));

    if (state.result) {
      host.appendChild(U.el('span', { class: 'hint', style: { whiteSpace: 'nowrap' } },
        U.num(state.result.rows.length) + ' devices · ' +
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

  function renderSidebar() {
    var host = U.qs('#sidebar');
    U.clear(host);

    /* sources */
    var sec = U.el('div', { class: 'side-section' });
    sec.appendChild(U.el('div', { class: 'side-head' }, 'Sources'));
    SOURCE_IDS.forEach(function (id) {
      var src = state.sources[id];
      var def = S.SOURCES[id];
      sec.appendChild(U.el('button', {
        class: 'side-item',
        onclick: function () { setTab('data'); }
      }, [
        U.el('span', { class: 'dot', style: { background: src ? 'var(--good)' : 'var(--surface-3)' } }),
        U.el('span', {}, def.short),
        src ? U.el('span', { class: 'count' }, U.num(src.records ? src.records.length : 0)) : U.el('span', { class: 'count' }, '—')
      ]));
    });
    host.appendChild(sec);

    if (!state.result) return;

    /* views */
    var vsec = U.el('div', { class: 'side-section' });
    vsec.appendChild(U.el('div', { class: 'side-head' }, [
      'Views',
      U.el('button', {
        class: 'btn sm ghost', style: { padding: '0 4px' },
        title: 'Create a view with your own filter',
        // Wrapped, not passed by reference: the handler's first argument would
        // otherwise be the click event, which openViewBuilder reads as a view
        // to edit.
        onclick: function () { openViewBuilder(); }
      }, '+')
    ]));
    allViews().forEach(function (v) {
      var n = viewCount(v);
      vsec.appendChild(U.el('button', {
        class: 'side-item' + (state.viewId === v.id && state.tab === 'devices' ? ' active' : ''),
        title: v.description || '',
        onclick: function () { setView(v.id); }
      }, [
        U.el('span', {}, v.name),
        U.el('span', { class: 'count' }, U.num(n)),
        U.el('span', {
          class: 'del',
          title: v.isCustom ? 'Edit this view' : 'See how this view is defined',
          onclick: function (e) {
            e.stopPropagation();
            openViewBuilder(v, v.isCustom ? 'edit' : 'inspect');
          }
        }, '\u2699'),
        v.isCustom ? U.el('span', {
          class: 'del', title: 'Delete this view',
          onclick: function (e) {
            e.stopPropagation();
            if (!confirm('Delete the view "' + v.name + '"? Devices and notes are not affected.')) return;
            state.customViews = state.customViews.filter(function (x) { return x.id !== v.id; });
            global.Store.set('customViews', state.customViews);
            delete state.viewColumnsById[v.id];
            global.Store.set('viewColumns', state.viewColumnsById);
            if (state.viewId === v.id) state.viewId = 'attention';
            render();
          }
        }, '✕') : null
      ]));
    });
    host.appendChild(vsec);

    /* active filters */
    if (state.siteFilter || state.issueFilter) {
      var fsec = U.el('div', { class: 'side-section' });
      fsec.appendChild(U.el('div', { class: 'side-head' }, 'Active filter'));
      if (state.siteFilter) {
        fsec.appendChild(U.el('button', {
          class: 'side-item',
          onclick: function () { state.siteFilter = null; render(); }
        }, [U.el('span', {}, 'Site: ' + U.truncate(state.siteFilter.name, 18)), U.el('span', { class: 'del', style: { opacity: 1 } }, '✕')]));
      }
      if (state.issueFilter) {
        fsec.appendChild(U.el('button', {
          class: 'side-item',
          onclick: function () { state.issueFilter = null; render(); }
        }, [U.el('span', {}, (R.BY_CODE[state.issueFilter] || {}).label || state.issueFilter), U.el('span', { class: 'del', style: { opacity: 1 } }, '✕')]));
      }
      host.appendChild(fsec);
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
      ({
        data: renderData,
        dashboard: renderDashboard,
        devices: renderDevices,
        map: renderMap,
        export: renderExport,
        settings: renderSettings
      }[state.tab] || renderData)(main);
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
      type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.xls', style: { display: 'none' },
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
      src ? U.el('div', { class: 'dz-file' }, src.fileName) : null,
      src ? U.el('div', { class: 'dz-meta' }, U.num(src.raw.length) + ' rows · ' +
            Object.keys(src.mapping).length + ' of ' + def.fields.length + ' columns mapped') : null,
      input
    ]);

    var wrap = U.el('div', {}, zone);
    if (src) {
      wrap.appendChild(U.el('div', { class: 'row tight', style: { marginTop: '8px', justifyContent: 'center' } }, [
        U.el('button', { class: 'btn sm', onclick: function () { openMappingModal(sourceId); } }, 'Check columns'),
        U.el('button', { class: 'btn sm ghost', onclick: function () { clearSource(sourceId); } }, 'Remove')
      ]));
      var missingReq = def.fields.filter(function (f) { return f.required && !src.mapping[f.key]; });
      if (missingReq.length) {
        wrap.appendChild(U.el('div', {
          class: 'hint', style: { color: 'var(--critical)', textAlign: 'center', marginTop: '4px' }
        }, 'Missing required column: ' + missingReq.map(function (f) { return f.label; }).join(', ')));
      }
    }
    return wrap;
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
      { label: 'Cancel', ghost: true },
      {
        label: 'Save mapping', primary: true, action: function () {
          var missing = def.fields.filter(function (f) { return f.required && !working[f.key]; });
          if (missing.length) {
            U.toast('Still need a column for: ' + missing.map(function (f) { return f.label; }).join(', '), 'err');
            return false;
          }
          src.mapping = working;
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
      class: 'btn sm', onclick: function () { openColumnPicker(view); }
    }, 'Columns'));

    controls.appendChild(U.el('button', {
      class: 'btn sm',
      title: view.isCustom ? 'Change this view\u2019s conditions' : 'See how this view is defined, and copy it',
      onclick: function () { openViewBuilder(view, view.isCustom ? 'edit' : 'inspect'); }
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
          if (grid) grid.render();
          renderNoteBar();
          // For one device the dialog stays put and shows the entry appended,
          // which is the point of a running trail; a bulk add just closes.
          if (single) { drawHistory(); box.value = ''; box.focus(); }
        }
      }
    ]);
    setTimeout(function () { box.focus(); }, 60);
  }

  var previewHook = function () {};

  function openColumnPicker(view) {
    var chosen = grid.state.columns.slice();
    var body = U.el('div', { class: 'body' });
    body.appendChild(U.el('p', { class: 'hint' }, 'Pick the columns this view shows. Exports use the same set.'));
    var wrap = U.el('div', { style: { columns: '2', columnGap: '24px' } });
    V.COLUMNS.forEach(function (col) {
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
          delete state.viewColumnsById[view.id];
          global.Store.set('viewColumns', state.viewColumnsById);
          render();
        }
      },
      { label: 'Cancel', ghost: true },
      { label: 'Apply', primary: true, action: function () {
        // Preserve the canonical column order rather than click order.
        var ordered = V.COLUMNS.map(function (c) { return c.key; })
          .filter(function (k) { return chosen.indexOf(k) >= 0; });
        var next = ordered.length ? ordered : V.BASE_COLS.slice();
        if (next.indexOf('notes') < 0) next.unshift('notes');
        grid.setColumns(next);
        state.viewColumns = next;
        state.viewColumnsById[view.id] = next;
        global.Store.set('viewColumns', state.viewColumnsById);
        grid.render();
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

  function renderMap(main) {
    var agg = global.EstateMap.aggregate(state.result.rows, { includeOther: state.includeOtherOnMap });

    main.appendChild(U.el('div', { class: 'page-head' }, [
      U.el('h1', {}, 'Where the devices are'),
      U.el('div', { class: 'sub' }, 'Each dot is a site; the area of the dot is the number of devices recorded there.')
    ]));

    var controls = U.el('div', { class: 'row no-print', style: { marginBottom: '12px' } }, [
      U.el('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, [
        U.el('span', {}, 'Colour by'),
        U.el('select', {
          onchange: function (e) {
            state.mapMode = e.target.value;
            global.Store.set('mapMode', state.mapMode);
            drawMap(agg);
          }
        }, Object.keys(global.EstateMap.COLOUR_MODES).map(function (k) {
          return U.el('option', { value: k, selected: state.mapMode === k }, global.EstateMap.COLOUR_MODES[k].label);
        }))
      ]),
      U.el('label', { class: 'check' }, [
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

    main.appendChild(U.el('div', { id: 'map', class: 'card', style: { padding: '0', overflow: 'hidden' } }));

    var stats = U.el('div', { class: 'tiles', style: { marginTop: '16px' } }, [
      C.tile('Sites on the map', agg.mappable.length),
      C.tile('Sites without coordinates', agg.unmapped.length,
        agg.unmapped.length ? 'add a postcode or run the lookup' : 'all located'),
      C.tile('Locations not in the lookup', agg.unmatched.length,
        agg.unmatched.length ? 'add them to the lookup file' : 'all recognised'),
      C.tile('Devices with no location', agg.unlocated.length)
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

  function drawMap(agg) {
    global.EstateMap.render('map', agg, {
      mode: state.mapMode,
      onSelect: function (site) {
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

      tbody.appendChild(U.el('tr', {}, [
        U.el('td', {}, U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'checkbox', checked: fcfg.enabled,
            onchange: function (e) { fcfg.enabled = e.target.checked; persistFsConfig(); render(); }
          }),
          u.label
        ])),
        U.el('td', {}, [sourceSel, manualBox]),
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
      ['activeDays', 'Checked in within this many days counts as definitely still in use', 1, 90]
    ];
    var grid3 = U.el('div', { class: 'grid3', style: { marginTop: '12px' } });
    fields.forEach(function (f) {
      grid3.appendChild(U.el('div', { class: 'field' }, [
        U.el('label', {}, f[1]),
        U.el('input', {
          type: 'number', min: f[2], max: f[3], value: state.cfg[f[0]],
          onchange: function (e) {
            var v = parseInt(e.target.value, 10);
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
            JSON.stringify({ views: state.customViews, fsConfig: state.fsConfig, cfg: state.cfg }, null, 2),
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
  function openViewBuilder(existing, mode) {
    mode = mode || (existing ? 'edit' : 'new');
    var readOnly = mode === 'inspect';
    // Drop any hook left by a previous dialog before this one wires its own.
    previewHook = function () {};

    function blankDraft() {
      return {
        id: 'custom-' + Date.now().toString(36),
        name: '',
        description: '',
        columns: V.BASE_COLS.slice(),
        filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] }
      };
    }

    var draft;
    if (existing) {
      draft = {
        id: existing.id,
        name: existing.name,
        description: existing.description || '',
        columns: (state.viewColumnsById[existing.id] || existing.columns || V.BASE_COLS).slice(),
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
        'This view is built from a rule in code rather than from conditions — it lists Freshservice assets whose ' +
        'type is outside the computer types in Settings. A copy would not reproduce it, so copying is disabled.'));
    } else if (unfiltered) {
      body.appendChild(U.el('div', { class: 'hint', style: { marginBottom: '12px' } },
        'This view has no conditions: it lists every reconciled device. A copy starts from that and you can add ' +
        'conditions to narrow it.'));
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
      U.el('span', {}, 'Show devices where'),
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
      V.COLUMNS.forEach(function (c) {
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
          }, R.RULES.map(function (rule) {
            return U.el('option', { value: rule.code, selected: cond.value === rule.code }, rule.label);
          }));
        } else if (isAny) {
          valueControl = U.el('span', { class: 'hint' }, '');
        } else {
          var opDef = V.OPERATORS.filter(function (o) { return o.op === cond.op; })[0];
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
              }, V.OPERATORS.map(function (o) {
                return U.el('option', { value: o.op, selected: cond.op === o.op }, o.label);
              }));

        condHost.appendChild(U.el('div', { class: 'cond-row' }, [
          U.el('select', {
            onchange: function (e) {
              cond.field = e.target.value;
              cond.op = 'is';
              cond.value = cond.field === '__issue' ? R.RULES[0].code : '';
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
      if (!state.result) { preview.textContent = ''; return; }
      if (codeDriven) {
        preview.textContent = 'Matches ' + U.num(V.applyView(existing, state.result.rows).length) + ' devices.';
        return;
      }
      var n = state.result.rows.filter(function (r) { return V.testFilter(r, draft.filter); }).length;
      preview.textContent = U.num(n) + ' of ' + U.num(state.result.rows.length) + ' devices match right now.';
    }
    previewHook = updatePreview;      // called whenever a condition changes
    body.appendChild(preview);
    updatePreview();

    body.appendChild(U.el('div', { class: 'hint', style: { marginTop: '10px' } },
      'Which columns this view shows is set with the Columns button on the device list, and is remembered ' +
      'per view.'));

    function saveDraft(asCopy) {
      if (asCopy) {
        draft.id = 'custom-' + Date.now().toString(36);
        if (!/copy/i.test(draft.name)) draft.name = draft.name + ' (copy)';
      }
      if (!draft.name.trim()) { U.toast('Give the view a name.', 'err'); return false; }
      draft.filter.conditions = (draft.filter.conditions || []).filter(function (c) { return c.field; });
      state.customViews = state.customViews.filter(function (v) { return v.id !== draft.id; }).concat([draft]);
      global.Store.set('customViews', state.customViews);
      if (asCopy) {
        // Carry the original's columns onto the copy so it looks the same.
        state.viewColumnsById[draft.id] = draft.columns.slice();
        global.Store.set('viewColumns', state.viewColumnsById);
      }
      state.viewId = draft.id;
      setTab('devices');
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

  function modal(title, bodyEl, buttons) {
    var back = U.el('div', { class: 'modal-back' });
    function close() {
      if (back.parentNode) document.body.removeChild(back);
      document.removeEventListener('keydown', esc);
    }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });

    var m = U.el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
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
      setTab('dashboard');
      U.toast('Picked up where you left off — ' +
        Object.keys(state.sources).map(function (id) {
          return S.SOURCES[id].short + ' ' + U.num(state.sources[id].records.length);
        }).join(', ') +
        (state.restoredAt ? ', saved ' + U.fmtDate(state.restoredAt) : ''), 'ok', 7000);
    });
  }

  global.App = { init: init, state: state, render: render, loadSample: loadSample, recompute: recompute };
})(window);

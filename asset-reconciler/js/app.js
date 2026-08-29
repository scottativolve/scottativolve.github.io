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
    ['fields', 'headers', 'reference', 'referenceHeaders'].forEach(function (k) {
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
    exportScope: 'all'          // 'all' | 'view'
  };

  var grid = null;

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
  }

  function clearSource(id) {
    delete state.sources[id];
    recompute();
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

  function rowsForView(view) {
    if (!state.result) return [];
    var rows = V.applyView(view, state.result.rows);
    if (state.siteFilter) {
      rows = rows.filter(function (r) { return r.locationKey === state.siteFilter.key; });
    }
    if (state.issueFilter) {
      rows = rows.filter(function (r) { return r.issues.indexOf(state.issueFilter) >= 0; });
    }
    return rows;
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
        v.isCustom ? U.el('span', {
          class: 'del', title: 'Delete this view',
          onclick: function (e) {
            e.stopPropagation();
            state.customViews = state.customViews.filter(function (x) { return x.id !== v.id; });
            global.Store.set('customViews', state.customViews);
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

  function render() {
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
        'data never leaves your machine.')
    ]));

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
        'over ' + state.cfg.staleDays + ' days', function () { setView('stale'); })
    ]));

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
      oninput: U.debounce(function (e) { grid.setSearch(e.target.value); grid.render(); }, 180)
    });
    controls.appendChild(search);

    controls.appendChild(U.el('button', {
      class: 'btn sm', onclick: function () { openColumnPicker(view); }
    }, 'Columns'));

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
      title: 'Build the correction file from the devices in this view',
      onclick: function () { state.exportScope = 'view'; setTab('export'); }
    }, 'Build import file'));
    main.appendChild(controls);

    var gridHost = U.el('div');
    main.appendChild(gridHost);

    grid = T.create(gridHost, {
      selectable: false,
      pageSize: 150,
      onRowClick: function (r) { T.openDrawer(r); },
      onChipClick: function (code) { state.issueFilter = code; render(); },
      onGroupExport: function (name, members) {
        U.download('site-check-' + slug(name) + '-' + U.todayStamp() + '.csv', FX.sitePackCsv(members, name));
        U.toast('Exported ' + members.length + ' devices for ' + name, 'ok');
      },
      emptyText: 'Nothing in this view. That is good news — or loosen the thresholds in Settings.'
    });
    grid.setRows(rows);
    grid.setColumns(view.columns || V.BASE_COLS);
    if (view.sort) grid.setSort(view.sort);
    if (view.group) grid.setGroup(view.group);
    grid.render();
  }

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
      { label: 'Cancel', ghost: true },
      { label: 'Apply', primary: true, action: function () {
        // Preserve the canonical column order rather than click order.
        var ordered = V.COLUMNS.map(function (c) { return c.key; })
          .filter(function (k) { return chosen.indexOf(k) >= 0; });
        grid.setColumns(ordered.length ? ordered : V.BASE_COLS);
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
    var viewRows = rowsForView(view);
    var scopedRows = state.exportScope === 'view' ? viewRows : state.result.rows;

    var proposals = FX.buildProposals(scopedRows, cfg);
    var changeCount = proposals.reduce(function (a, p) { return a + p.changes.length; }, 0);

    /* Which devices the file covers. Getting this wrong is expensive - it is
       the difference between correcting 16 assets and correcting 1,000 - so it
       is stated at the top rather than left implicit. */
    var scopeCard = U.el('div', { class: 'card' });
    scopeCard.appendChild(U.el('h2', {}, 'Which devices'));
    scopeCard.appendChild(U.el('div', { class: 'row', style: { marginTop: '10px' } }, [
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'radio', name: 'exportscope', checked: state.exportScope === 'view',
          onchange: function () { state.exportScope = 'view'; render(); }
        }),
        'Just the current view — ' + view.name + ' (' + U.num(viewRows.length) + ' devices)'
      ]),
      U.el('label', { class: 'check' }, [
        U.el('input', {
          type: 'radio', name: 'exportscope', checked: state.exportScope === 'all',
          onchange: function () { state.exportScope = 'all'; render(); }
        }),
        'Every device (' + U.num(state.result.rows.length) + ')'
      ])
    ]));
    if (state.exportScope === 'view' && (state.siteFilter || state.issueFilter)) {
      scopeCard.appendChild(U.el('div', { class: 'hint', style: { marginTop: '6px' } },
        'The filters you set on the Devices tab apply too: ' +
        [state.siteFilter ? 'site ' + state.siteFilter.name : null,
         state.issueFilter ? 'issue ' + ((R.BY_CODE[state.issueFilter] || {}).label || '') : null]
          .filter(Boolean).join(', ') + '.'));
    }
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

    /* --------------------------------------------------- reference columns */
    var refCard = U.el('div', { class: 'card' });
    refCard.appendChild(U.el('header', {}, [
      U.el('h2', {}, 'Extra columns for reference'),
      U.el('span', { class: 'sub' }, 'Included for context, not changed')
    ]));
    refCard.appendChild(U.el('p', { class: 'hint' },
      'These carry the value Freshservice already holds, so they identify the asset for whoever reviews or ' +
      'approves the file. Mapping one on import writes the same value back, which changes nothing; leave it ' +
      'unmapped and it is just context. To correct a field rather than echo it, tick it above instead.'));

    var refGrid = U.el('div', { class: 'grid3', style: { marginTop: '10px' } });
    FX.REFERENCE.forEach(function (r) {
      var updating = cfg.fields[r.field] && cfg.fields[r.field].enabled;
      var isMatch = (cfg.headers[cfg.matchField] || '') === (cfg.referenceHeaders[r.field] || r.header);
      var blocked = updating || isMatch;
      refGrid.appendChild(U.el('div', {}, [
        U.el('label', { class: 'check' }, [
          U.el('input', {
            type: 'checkbox',
            checked: !blocked && !!cfg.reference[r.field],
            disabled: blocked,
            onchange: function (e) { cfg.reference[r.field] = e.target.checked; persistFsConfig(); render(); }
          }),
          r.label
        ]),
        blocked ? U.el('div', { class: 'hint', style: { marginLeft: '24px' } },
          updating ? 'already included as an update' : 'already the match column') : null,
        !blocked && cfg.reference[r.field] ? U.el('input', {
          type: 'text', style: { marginLeft: '24px', marginTop: '4px', width: 'calc(100% - 24px)' },
          value: cfg.referenceHeaders[r.field] || r.header,
          onchange: function (e) { cfg.referenceHeaders[r.field] = e.target.value; persistFsConfig(); }
        }) : null
      ]));
    });
    refCard.appendChild(refGrid);
    main.appendChild(refCard);

    /* ------------------------------------------------------- the result */
    var out = U.el('div', { class: 'card' });
    out.appendChild(U.el('header', {}, [
      U.el('h2', {}, 'Proposed changes'),
      U.el('span', { class: 'sub' }, U.num(changeCount) + ' change' + (changeCount === 1 ? '' : 's') +
        ' across ' + U.num(proposals.length) + ' asset' + (proposals.length === 1 ? '' : 's'))
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
      if (rule.fix && rule.fix.field === field) {
        worst = Math.max(worst, R.SEVERITY_ORDER[rule.severity] || 0);
      }
    });
    return worst;
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
      var on = state.enabledRules[rule.code] !== false;
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

    var housekeeping = U.el('div', { class: 'card' });
    housekeeping.appendChild(U.el('h2', {}, 'Stored on this computer'));
    housekeeping.appendChild(U.el('p', { class: 'hint' },
      'The tool keeps your column mappings, thresholds, saved views and geocoding results in this browser' +
      (global.Store.persistent ? '' : ' — except that this browser is blocking storage, so they will be lost when the tab closes') +
      '. Device data is never written to disk unless you use "Save project".'));
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
            'application/json');
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

  function openViewBuilder(existing) {
    var draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: 'custom-' + Date.now().toString(36),
      name: '',
      description: '',
      columns: V.BASE_COLS.slice(),
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] }
    };

    var body = U.el('div', { class: 'body' });
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
            onchange: function (e) { cond.value = e.target.value; }
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
                oninput: function (e) { cond.value = e.target.value; }
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
    }
    drawConditions();

    var preview = U.el('div', { class: 'hint', style: { marginTop: '14px' } });
    function updatePreview() {
      if (!state.result) { preview.textContent = ''; return; }
      var n = state.result.rows.filter(function (r) { return V.testFilter(r, draft.filter); }).length;
      preview.textContent = n + ' of ' + state.result.rows.length + ' devices match right now.';
    }
    body.appendChild(U.el('button', { class: 'btn sm ghost', onclick: updatePreview }, 'Test this filter'));
    body.appendChild(preview);

    modal(existing ? 'Edit view' : 'New view', body, [
      { label: 'Cancel', ghost: true },
      {
        label: 'Save view', primary: true, action: function () {
          if (!draft.name.trim()) { U.toast('Give the view a name.', 'err'); return false; }
          draft.filter.conditions = draft.filter.conditions.filter(function (c) { return c.field; });
          state.customViews = state.customViews.filter(function (v) { return v.id !== draft.id; }).concat([draft]);
          global.Store.set('customViews', state.customViews);
          state.viewId = draft.id;
          setTab('devices');
          U.toast('View saved. Use "Export configuration" in Settings to share it with colleagues.', 'ok', 6000);
        }
      }
    ]);
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
            var json = JSON.parse(String(fr.result));
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
    setTimeout(function () { document.body.removeChild(input); }, 1000);
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
      cfg: state.cfg,
      enabledRules: state.enabledRules,
      customViews: state.customViews,
      fsConfig: state.fsConfig,
      sources: {}
    };
    SOURCE_IDS.forEach(function (id) {
      var s = state.sources[id];
      if (!s) return;
      payload.sources[id] = { fileName: s.fileName, headers: s.headers, mapping: s.mapping, raw: s.raw };
    });
    U.download('asset-reconciler-' + U.todayStamp() + '.json', JSON.stringify(payload), 'application/json');
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
            var p = JSON.parse(String(fr.result));
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
            global.EstateMap.reset();
            recompute();
            setTab('dashboard');
            U.toast('Project loaded from ' + f.name, 'ok');
          } catch (err) {
            U.toast('That is not an Asset Reconciler project file.', 'err');
          }
        };
        fr.readAsText(f);
      }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { document.body.removeChild(input); }, 1000);
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

    render();
  }

  global.App = { init: init, state: state, render: render, loadSample: loadSample, recompute: recompute };
})(window);

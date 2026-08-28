/* The data grid: sorting, paging, selection, grouping and the row detail
   drawer. Kept deliberately simple - a thousand rows is nothing for the DOM
   once it is paged. */
(function (global) {
  'use strict';

  var U = global.U, V = global.Views, R = global.Rules, N = global.Norm;

  function severityBadge(sev) {
    if (!sev) return U.el('span', { class: 'badge ok' }, [U.el('span', { class: 'sev sev-ok' }), 'Clean']);
    var label = sev === 'high' ? 'High' : sev === 'medium' ? 'Medium' : 'Low';
    return U.el('span', { class: 'badge ' + sev }, [U.el('span', { class: 'sev sev-' + sev }), label]);
  }

  function issueChips(row, onChipClick) {
    var frag = document.createDocumentFragment();
    if (!row.issues.length) {
      frag.appendChild(U.el('span', { class: 'badge ok' }, [U.el('span', { class: 'sev sev-ok' }), 'No issues']));
      return frag;
    }
    var ordered = row.issues.slice().sort(function (a, b) {
      return R.SEVERITY_ORDER[(R.BY_CODE[b] || {}).severity] - R.SEVERITY_ORDER[(R.BY_CODE[a] || {}).severity];
    });
    ordered.forEach(function (code) {
      var rule = R.BY_CODE[code];
      if (!rule) return;
      var chip = U.el('span', {
        class: 'badge ' + rule.severity,
        title: (row.details && row.details[code]) || rule.help
      }, [U.el('span', { class: 'sev sev-' + rule.severity }), rule.label]);
      if (onChipClick) {
        chip.style.cursor = 'pointer';
        chip.addEventListener('click', function (e) { e.stopPropagation(); onChipClick(code); });
      }
      frag.appendChild(chip);
    });
    return frag;
  }

  function renderCell(td, row, col, ctx) {
    var v = col.get(row);

    if (col.key === 'issues') {
      td.className = 'chips';
      td.appendChild(issueChips(row, ctx.onChipClick));
      return;
    }
    if (col.key === 'severity') {
      td.appendChild(severityBadge(row.severity));
      return;
    }
    if (col.key === 'userStatus') {
      var map = { match: ['ok', 'Agrees'], mismatch: ['high', 'Differs'], partial: ['medium', 'Similar'], unknown: ['low', 'Unknown'] };
      var m = map[v] || ['low', v || '—'];
      td.appendChild(U.el('span', { class: 'badge ' + m[0] }, [U.el('span', { class: 'sev sev-' + (m[0] === 'ok' ? 'ok' : m[0]) }), m[1]]));
      return;
    }
    if (col.type === 'date') {
      if (!v) { td.appendChild(U.el('span', { class: 'muted' }, 'never')); return; }
      td.appendChild(U.el('span', { title: U.fmtDate(v) }, U.fmtDate(v)));
      td.appendChild(U.el('div', { class: 'muted', style: { fontSize: '11px' } }, U.ageLabel(v) + ' ago'));
      return;
    }
    if (col.type === 'number') {
      td.className = 'num';
      td.textContent = (v === null || v === undefined || v === '') ? '—' : U.num(v);
      return;
    }

    var s = v === null || v === undefined ? '' : String(v);
    if (!s) { td.appendChild(U.el('span', { class: 'muted' }, '—')); return; }

    // Highlight the two fields the reconciliation is really about when they
    // disagree, so a scan down the column finds the problems.
    var isDiff = (col.key === 'fsUser' || col.key === 'intuneUser') && row.userStatus === 'mismatch';
    td.appendChild(U.el('span', {
      class: (col.strong ? 'strong ' : '') + (isDiff ? 'diff' : ''),
      title: s.length > 40 ? s : null,
      style: col.strong ? { fontWeight: '600' } : null
    }, U.truncate(s, 46)));
  }

  function create(container, opts) {
    opts = opts || {};
    var state = {
      rows: [],
      columns: V.BASE_COLS.slice(),
      sort: null,
      page: 0,
      pageSize: opts.pageSize || 150,
      selection: new Set(),
      group: null,
      search: ''
    };

    var host = container;

    function visibleRows() {
      var rows = state.rows;
      if (state.search) {
        var q = state.search.toLowerCase();
        rows = rows.filter(function (r) {
          return state.columns.some(function (k) {
            var v = V.colValue(r, k);
            if (Array.isArray(v)) v = v.join(' ');
            if (v instanceof Date) v = U.fmtDate(v);
            return String(v === null || v === undefined ? '' : v).toLowerCase().indexOf(q) >= 0;
          }) || String(r.name).toLowerCase().indexOf(q) >= 0;
        });
      }
      if (state.sort) {
        var col = V.COL_BY_KEY[state.sort.key];
        var keyFn = col && col.sortKey ? col.sortKey : function (r) { return V.colValue(r, state.sort.key); };
        rows = U.sortBy(rows, keyFn, state.sort.dir);
      }
      return rows;
    }

    function render() {
      U.clear(host);
      var all = visibleRows();
      var totalPages = Math.max(1, Math.ceil(all.length / state.pageSize));
      if (state.page >= totalPages) state.page = totalPages - 1;
      var pageRows = state.group ? all : all.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

      if (!all.length) {
        host.appendChild(U.el('div', { class: 'table-wrap' },
          U.el('div', { class: 'empty' }, opts.emptyText || 'No devices match this view.')));
        return;
      }

      var wrap = U.el('div', { class: 'table-wrap' });
      var table = U.el('table', { class: 'grid' });

      /* ------------------------------------------------------- header */
      var thead = U.el('thead');
      var htr = U.el('tr');
      if (opts.selectable) {
        var allSelected = pageRows.length > 0 && pageRows.every(function (r) { return state.selection.has(r.id); });
        htr.appendChild(U.el('th', { class: 'nosort', style: { width: '30px' } },
          U.el('input', {
            type: 'checkbox', checked: allSelected,
            title: 'Select everything on this page',
            onchange: function (e) {
              pageRows.forEach(function (r) {
                if (e.target.checked) state.selection.add(r.id); else state.selection.delete(r.id);
              });
              if (opts.onSelectionChange) opts.onSelectionChange(state.selection);
              render();
            }
          })));
      }
      state.columns.forEach(function (key) {
        var col = V.COL_BY_KEY[key];
        if (!col) return;
        var active = state.sort && state.sort.key === key;
        var th = U.el('th', {
          title: 'Sort by ' + col.label,
          onclick: function () {
            if (active && state.sort.dir === 'asc') state.sort = { key: key, dir: 'desc' };
            else if (active) state.sort = null;
            else state.sort = { key: key, dir: 'asc' };
            render();
          }
        }, col.label);
        if (active) th.appendChild(U.el('span', { class: 'arrow' }, state.sort.dir === 'asc' ? '▲' : '▼'));
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      /* --------------------------------------------------------- body */
      var tbody = U.el('tbody');
      var ctx = { onChipClick: opts.onChipClick };

      function addRow(r) {
        var tr = U.el('tr', {
          class: state.selection.has(r.id) ? 'selected' : '',
          onclick: function (e) {
            if (e.target.tagName === 'INPUT' || e.target.classList.contains('badge')) return;
            if (opts.onRowClick) opts.onRowClick(r);
          }
        });
        if (opts.selectable) {
          tr.appendChild(U.el('td', {}, U.el('input', {
            type: 'checkbox', checked: state.selection.has(r.id),
            onchange: function (e) {
              if (e.target.checked) state.selection.add(r.id); else state.selection.delete(r.id);
              tr.classList.toggle('selected', e.target.checked);
              if (opts.onSelectionChange) opts.onSelectionChange(state.selection);
            }
          })));
        }
        state.columns.forEach(function (key) {
          var col = V.COL_BY_KEY[key];
          if (!col) return;
          var td = U.el('td');
          renderCell(td, r, col, ctx);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }

      if (state.group) {
        var groups = U.groupBy(pageRows, function (r) { return V.colValue(r, state.group) || '(not set)'; });
        var keys = Array.from(groups.keys()).sort(function (a, b) { return String(a).localeCompare(String(b)); });
        keys.forEach(function (k) {
          var members = groups.get(k);
          var span = state.columns.length + (opts.selectable ? 1 : 0);
          var gtr = U.el('tr');
          gtr.appendChild(U.el('td', {
            colspan: span,
            style: {
              background: 'var(--surface-2)', fontWeight: '650', fontSize: '12.5px',
              position: 'sticky', top: '30px'
            }
          }, [
            String(k),
            U.el('span', { class: 'pill', style: { marginLeft: '8px' } },
              members.length + ' device' + (members.length === 1 ? '' : 's')),
            opts.onGroupExport ? U.el('button', {
              class: 'btn sm ghost no-print',
              style: { marginLeft: '8px' },
              onclick: function (e) { e.stopPropagation(); opts.onGroupExport(String(k), members); }
            }, 'Export this site') : null
          ]));
          tbody.appendChild(gtr);
          members.forEach(addRow);
        });
      } else {
        pageRows.forEach(addRow);
      }

      table.appendChild(tbody);
      wrap.appendChild(table);
      host.appendChild(wrap);

      /* -------------------------------------------------------- pager */
      var pager = U.el('div', { class: 'pager no-print' });
      pager.appendChild(U.el('span', {}, state.group
        ? U.num(all.length) + ' devices in ' + U.num(new Set(all.map(function (r) { return V.colValue(r, state.group); })).size) + ' groups'
        : 'Showing ' + U.num(Math.min(all.length, state.page * state.pageSize + 1)) + '–' +
          U.num(Math.min(all.length, (state.page + 1) * state.pageSize)) + ' of ' + U.num(all.length)));
      if (!state.group && totalPages > 1) {
        pager.appendChild(U.el('button', {
          class: 'btn sm', disabled: state.page === 0,
          onclick: function () { state.page--; render(); }
        }, '‹ Previous'));
        pager.appendChild(U.el('span', {}, 'Page ' + (state.page + 1) + ' of ' + totalPages));
        pager.appendChild(U.el('button', {
          class: 'btn sm', disabled: state.page >= totalPages - 1,
          onclick: function () { state.page++; render(); }
        }, 'Next ›'));
      }
      if (opts.selectable && state.selection.size) {
        pager.appendChild(U.el('span', { style: { marginLeft: 'auto', fontWeight: '600' } },
          U.num(state.selection.size) + ' selected'));
        pager.appendChild(U.el('button', {
          class: 'btn sm ghost',
          onclick: function () { state.selection.clear(); if (opts.onSelectionChange) opts.onSelectionChange(state.selection); render(); }
        }, 'Clear'));
      }
      host.appendChild(pager);
    }

    return {
      state: state,
      render: render,
      visibleRows: visibleRows,
      setRows: function (rows) { state.rows = rows; state.page = 0; },
      setColumns: function (cols) { state.columns = cols.slice(); },
      setSort: function (s) { state.sort = s; },
      setGroup: function (g) { state.group = g; },
      setSearch: function (q) { state.search = q; state.page = 0; },
      selected: function () {
        return state.rows.filter(function (r) { return state.selection.has(r.id); });
      }
    };
  }

  /* ------------------------------------------------------- detail drawer */

  function fieldRows(row) {
    return [
      ['Device name', row.fs ? row.fs.name : '', row.intune ? row.intune.name : ''],
      ['Serial number', row.fs ? row.fs.serial : '', row.intune ? row.intune.serial : ''],
      ['Assigned user', row.fsUser, row.intuneUser],
      ['User email / UPN', row.fs ? row.fs.userEmail : '', row.intune ? row.intune.primaryUpn : ''],
      ['Location', row.locationRaw, '—'],
      ['Asset state', row.state, '—'],
      ['Asset type', row.assetType, '—'],
      ['Asset tag', row.assetTag, '—'],
      ['Model', row.fs ? row.fs.model : '', row.intune ? row.intune.model : ''],
      ['Manufacturer', row.fs ? row.fs.manufacturer : '', row.intune ? row.intune.manufacturer : ''],
      ['Operating system', row.fs ? row.fs.os : '', row.intune ? row.intune.os : ''],
      ['OS version', row.fs ? row.fs.osVersion : '', row.intune ? row.intune.osVersion : ''],
      ['Compliance', '—', row.compliance],
      ['Ownership', '—', row.ownership],
      ['Last seen', row.lastAudit ? U.fmtDate(row.lastAudit) : 'never', row.lastCheckIn ? U.fmtDate(row.lastCheckIn) : 'never'],
      ['Department', row.department, '—']
    ];
  }

  function openDrawer(row, onClose) {
    var back = U.el('div', { class: 'drawer-back', onclick: close });
    var drawer = U.el('div', { class: 'drawer', role: 'dialog', 'aria-label': 'Device detail' });

    function close() {
      if (back.parentNode) document.body.removeChild(back);
      if (drawer.parentNode) document.body.removeChild(drawer);
      document.removeEventListener('keydown', esc);
      if (onClose) onClose();
    }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);

    drawer.appendChild(U.el('header', {}, [
      U.el('div', {}, [
        U.el('h2', {}, row.name),
        U.el('div', { class: 'hint' },
          (row.matchType === 'serial' ? 'Matched on serial number'
            : row.matchType === 'name' ? 'Matched on device name'
            : row.matchType === 'fs-only' ? 'Freshservice only — no Intune record'
            : 'Intune only — no Freshservice record'))
      ]),
      U.el('div', { class: 'spacer' }),
      U.el('button', { class: 'btn sm ghost', onclick: close, 'aria-label': 'Close' }, '✕')
    ]));

    var body = U.el('div', { class: 'body' });

    if (row.issues.length) {
      var issuesCard = U.el('div', { class: 'card', style: { marginBottom: '16px' } });
      issuesCard.appendChild(U.el('h3', { style: { marginBottom: '8px' } }, 'What is wrong'));
      row.issues.forEach(function (code) {
        var rule = R.BY_CODE[code];
        if (!rule) return;
        issuesCard.appendChild(U.el('div', { style: { marginBottom: '10px' } }, [
          U.el('div', { class: 'row tight' }, [
            U.el('span', { class: 'badge ' + rule.severity }, [U.el('span', { class: 'sev sev-' + rule.severity }), rule.label])
          ]),
          U.el('div', { style: { fontSize: '12.5px', marginTop: '3px' } }, (row.details && row.details[code]) || ''),
          U.el('div', { class: 'hint', style: { marginTop: '2px' } }, rule.help)
        ]));
      });
      body.appendChild(issuesCard);
    } else {
      body.appendChild(U.el('div', { class: 'card' }, [
        U.el('span', { class: 'badge ok' }, [U.el('span', { class: 'sev sev-ok' }), 'No issues found']),
        U.el('div', { class: 'hint', style: { marginTop: '6px' } },
          'Both systems agree on this device, and nothing is stale.')
      ]));
    }

    var cmp = U.el('div', { class: 'card' });
    cmp.appendChild(U.el('h3', { style: { marginBottom: '10px' } }, 'Side by side'));
    var kv = U.el('div', { class: 'kv' });
    kv.appendChild(U.el('div', { class: 'hdr' }, 'Field'));
    kv.appendChild(U.el('div', { class: 'hdr' }, 'Freshservice'));
    kv.appendChild(U.el('div', { class: 'hdr' }, 'Intune'));
    fieldRows(row).forEach(function (f) {
      var a = N.clean(f[1]), b = N.clean(f[2]);
      var differs = a && b && a !== '—' && b !== '—' && !N.looseEqual(a, b);
      if (f[0] === 'Assigned user') differs = row.userStatus === 'mismatch';
      kv.appendChild(U.el('div', { class: 'k' }, f[0]));
      kv.appendChild(U.el('div', { class: differs ? 'mismatch' : '' }, a || '—'));
      kv.appendChild(U.el('div', { class: differs ? 'mismatch' : '' }, b || '—'));
    });
    cmp.appendChild(kv);
    body.appendChild(cmp);

    if (row.ver) {
      var v = U.el('div', { class: 'card' });
      v.appendChild(U.el('h3', { style: { marginBottom: '8px' } }, 'Site verification return'));
      [['Device present', row.ver.confirmedPresent], ['Confirmed location', row.ver.confirmedLocation],
       ['Confirmed user', row.ver.confirmedUser], ['Confirmed status', row.ver.confirmedState],
       ['Notes', row.ver.notes]].forEach(function (p) {
        if (N.isBlank(p[1])) return;
        v.appendChild(U.el('div', { style: { fontSize: '12.5px' } }, [
          U.el('span', { style: { color: 'var(--text-secondary)' } }, p[0] + ': '),
          U.el('strong', {}, p[1])
        ]));
      });
      body.appendChild(v);
    }

    if (row.site) {
      var st = U.el('div', { class: 'card' });
      st.appendChild(U.el('h3', { style: { marginBottom: '8px' } }, 'Site'));
      st.appendChild(U.el('div', { style: { fontSize: '12.5px' } }, N.clean(row.site.location)));
      var addr = global.Geo.addressOf(row.site);
      if (addr) st.appendChild(U.el('div', { class: 'hint' }, addr));
      if (row.region) st.appendChild(U.el('div', { class: 'hint' }, 'Region: ' + row.region));
      body.appendChild(st);
    }

    drawer.appendChild(body);
    document.body.appendChild(back);
    document.body.appendChild(drawer);
  }

  global.Table = { create: create, openDrawer: openDrawer, severityBadge: severityBadge, issueChips: issueChips };
})(window);

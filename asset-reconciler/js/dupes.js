/* Finding duplicate entries *within* each source file, keyed on serial number.

   This is deliberately separate from reconciliation. Reconciliation produces
   one row per physical device and hides the fact that a file held it twice;
   here the question is the opposite one - which rows in this particular export
   are stale copies that should be deleted from the system that produced it.

   The wrinkle is Arctic Wolf, which carries no serial column at all. Where the
   build names a machine after its serial with a build-type prefix
   (STD-5CD4092H17, SHR-5CD4092H17), the serial can be recovered from the name,
   which is also what makes a rebuild under a different build type visible as
   the duplicate it is. */
(function (global) {
  'use strict';

  var N = global.Norm, U = global.U;

  var DEFAULT_PREFIXES = 'STD|SHR|IVOLVE|LAP|DSK';

  /* The date each source uses to say "this record is current". */
  var RECENCY = {
    freshservice: ['lastAudit', 'createdAt'],
    intune: ['lastCheckIn', 'enrolled'],
    arcticwolf: ['lastSeen', 'lastScan']
  };

  var LABEL_FIELDS = {
    freshservice: ['name', 'assetTag', 'state', 'user', 'location'],
    intune: ['name', 'primaryUser', 'compliance', 'ownership'],
    arcticwolf: ['name', 'riskScore', 'risks', 'criticality']
  };

  function prefixRegex(prefixes) {
    // An empty string means "no prefixes", not "use the defaults" - otherwise
    // the setting cannot be switched off and quietly ignores what was typed.
    var raw = (prefixes === undefined || prefixes === null) ? DEFAULT_PREFIXES : String(prefixes);
    var list = raw
      .split(/[|,;\s]+/).map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return p.replace(/[.*+?^${}()[\]\\]/g, '\\$&'); });
    if (!list.length) return null;
    try { return new RegExp('^(?:' + list.join('|') + ')[-_ ]+', 'i'); }
    catch (e) { return null; }
  }

  /* Recover the serial a device name encodes, if it encodes one. */
  function serialFromName(name, prefixes) {
    var s = N.deviceName(name);
    if (!s) return '';
    var re = prefixRegex(prefixes);
    var stripped = re ? s.replace(re, '') : s;
    if (stripped === s) return '';          // no build prefix, so no claim made
    return N.serial(stripped);
  }

  /* The serial to group a record on, and where it came from. */
  function serialKey(rec, sourceId, prefixes) {
    var direct = N.serial(rec.serial);
    if (direct) return { key: direct, from: 'serial column' };
    var derived = serialFromName(rec.name, prefixes);
    if (derived) return { key: derived, from: 'device name' };
    return { key: '', from: '' };
  }

  function recencyOf(rec, sourceId) {
    var fields = RECENCY[sourceId] || [];
    for (var i = 0; i < fields.length; i++) {
      var d = U.parseDate(rec[fields[i]]);
      if (d) return { at: d, field: fields[i] };
    }
    return { at: null, field: '' };
  }

  /* Group one source's records by serial and return only the groups with more
     than one entry, newest first within each group. */
  function findDuplicates(sourceId, records, prefixes) {
    var groups = new Map();

    (records || []).forEach(function (rec, idx) {
      var sk = serialKey(rec, sourceId, prefixes);
      if (!sk.key) return;                        // nothing reliable to group on
      if (!groups.has(sk.key)) groups.set(sk.key, { serial: sk.key, entries: [] });
      var r = recencyOf(rec, sourceId);
      groups.get(sk.key).entries.push({
        rec: rec,
        row: rec._row || (idx + 2),
        name: N.clean(rec.name),
        keyFrom: sk.from,
        at: r.at,
        atField: r.field
      });
    });

    var out = [];
    groups.forEach(function (g) {
      if (g.entries.length < 2) return;

      // Newest first. An entry with no date cannot be the current one while a
      // dated entry exists, so it sorts last.
      g.entries.sort(function (a, b) {
        if (a.at && b.at) return b.at - a.at;
        if (a.at) return -1;
        if (b.at) return 1;
        return 0;
      });

      var newest = g.entries[0].at;
      var tied = !!newest && g.entries.filter(function (e) {
        return e.at && Math.abs(e.at - newest) < 60000;      // within a minute
      }).length > 1;

      g.entries.forEach(function (e, i) {
        e.keep = i === 0;
        e.ambiguous = tied || (!newest && true);
      });

      // A rebuild under a different build type is the case worth calling out,
      // because the names differ and the duplicate is easy to miss.
      var names = g.entries.map(function (e) { return N.deviceName(e.name); });
      g.namesDiffer = names.some(function (n) { return n !== names[0]; });
      g.ambiguous = g.entries.some(function (e) { return e.ambiguous; });
      g.count = g.entries.length;
      out.push(g);
    });

    // Worst first: most copies, then the ones whose names disagree.
    out.sort(function (a, b) {
      return b.count - a.count ||
             (b.namesDiffer ? 1 : 0) - (a.namesDiffer ? 1 : 0) ||
             String(a.serial).localeCompare(String(b.serial));
    });
    return out;
  }

  function summarise(groups) {
    var toRemove = 0, ambiguous = 0;
    groups.forEach(function (g) {
      toRemove += g.count - 1;
      if (g.ambiguous) ambiguous++;
    });
    return { serials: groups.length, toRemove: toRemove, ambiguous: ambiguous };
  }

  /* Rows for the export. mode 'remove' gives only the stale copies; 'all'
     gives every entry in every duplicate group, keep flag included. */
  function exportRows(sourceId, groups, mode) {
    var label = (global.Schema.SOURCES[sourceId] || {}).label || sourceId;
    var extra = LABEL_FIELDS[sourceId] || ['name'];
    var rows = [];

    groups.forEach(function (g) {
      g.entries.forEach(function (e) {
        if (mode === 'remove' && e.keep) return;
        var row = {
          'Source': label,
          'Serial': g.serial,
          'Matched on': e.keyFrom,
          'Row in export': e.row,
          'Device name': e.name,
          'Copies of this serial': g.count,
          'Action': e.keep ? 'KEEP (most recent)' : 'Remove (superseded)',
          'Last seen': e.at ? U.fmtDate(e.at) : 'no date in export',
          'Names differ across copies': g.namesDiffer ? 'yes' : 'no',
          'Needs a human decision': e.ambiguous ? 'yes — dates equal or missing' : 'no'
        };
        extra.forEach(function (f) {
          if (f === 'name') return;
          var def = global.Schema.fieldDef(sourceId, f);
          if (!def) return;
          var v = e.rec[f];
          row[def.label] = v === null || v === undefined ? '' : v;
        });
        rows.push(row);
      });
    });
    return rows;
  }

  /* Can this source be grouped at all? Arctic Wolf has no serial column, so
     with no build prefixes configured there is nothing to group on - which is
     a different answer from "no duplicates found". */
  function groupable(sourceId, records, prefixes) {
    var anySerial = (records || []).some(function (r) { return N.serial(r.serial); });
    if (anySerial) return { ok: true, via: 'serial column' };
    var anyDerived = (records || []).some(function (r) { return serialFromName(r.name, prefixes); });
    if (anyDerived) return { ok: true, via: 'device name' };
    return {
      ok: false,
      why: prefixRegex(prefixes)
        ? 'No row in this file has a serial number, and no device name matches one of the build prefixes.'
        : 'This file has no serial column, and no build prefixes are configured, so there is nothing to group on.'
    };
  }

  global.Dupes = {
    groupable: groupable,
    DEFAULT_PREFIXES: DEFAULT_PREFIXES,
    serialFromName: serialFromName,
    serialKey: serialKey,
    findDuplicates: findDuplicates,
    summarise: summarise,
    exportRows: exportRows
  };
})(window);

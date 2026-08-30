/* Per-device notes: an append-only, timestamped audit trail of what was done
   about each device.

   The hard part is identity. A note has to still be attached to the same
   machine after next month's exports are loaded, when every row is rebuilt
   from scratch and its position has changed. So notes are keyed on what the
   device is, not where it sat in a file: serial number first, then device
   name, then asset tag. Every note records all three, and a lookup matches on
   any of them - so a machine that is renamed keeps its notes through the
   serial, and one whose serial is filled in later keeps them through the
   name. */
(function (global) {
  'use strict';

  var KEY = 'notes.v1';
  var data = load();
  var alias = {};                      // every known identifier -> primary key
  reindex();

  function load() {
    var raw = global.Store.get(KEY, null);
    if (!raw || typeof raw !== 'object' || !raw.devices) return { version: 1, devices: {} };
    return raw;
  }

  function persist() {
    var ok = global.Store.set(KEY, data);
    reindex();
    return ok;
  }

  function idsFor(row) {
    var N = global.Norm;
    return {
      serial: N.serial(row.serial) || '',
      name: N.deviceName(row.name) || '',
      tag: (row.assetTag || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    };
  }

  function keysFor(row) {
    var ids = idsFor(row);
    var out = [];
    if (ids.serial) out.push('s:' + ids.serial);
    if (ids.name) out.push('n:' + ids.name);
    if (ids.tag) out.push('t:' + ids.tag);
    return out;
  }

  function reindex() {
    alias = {};
    Object.keys(data.devices).forEach(function (primary) {
      var rec = data.devices[primary];
      alias[primary] = primary;
      (rec.keys || []).forEach(function (k) {
        // First writer wins, so two devices that once shared a name cannot
        // silently swap note histories.
        if (!alias[k]) alias[k] = primary;
      });
    });
  }

  /* The record for this device, or null. */
  function recordFor(row) {
    var keys = keysFor(row);
    for (var i = 0; i < keys.length; i++) {
      var primary = alias[keys[i]];
      if (primary && data.devices[primary]) return data.devices[primary];
    }
    return null;
  }

  function entriesFor(row) {
    var rec = recordFor(row);
    return rec ? rec.entries.slice() : [];
  }

  function countFor(row) {
    var rec = recordFor(row);
    return rec ? rec.entries.length : 0;
  }

  /* Append one note, with the same timestamp, to every row given. */
  function add(rows, text, author) {
    text = String(text || '').trim();
    if (!text) return { added: 0 };
    var ts = new Date().toISOString();

    rows.forEach(function (row) {
      var keys = keysFor(row);
      if (!keys.length) return;                    // nothing stable to hang it on
      var rec = recordFor(row);
      if (!rec) {
        rec = {
          keys: keys,
          label: row.name || row.serial || row.assetTag || '(unnamed)',
          entries: []
        };
        data.devices[keys[0]] = rec;
      }
      // Keep the identifier list current: a serial filled in since the first
      // note should start matching too.
      keys.forEach(function (k) { if (rec.keys.indexOf(k) < 0) rec.keys.push(k); });
      rec.label = row.name || rec.label;
      rec.entries.push({ ts: ts, text: text, by: author || '' });
    });

    var ok = persist();
    return { added: rows.length, ts: ts, stored: ok };
  }

  /* Remove one entry. Notes are append-only by design, but a typo should not
     be permanent. */
  function removeEntry(row, ts, text) {
    var rec = recordFor(row);
    if (!rec) return false;
    var idx = -1;
    for (var i = 0; i < rec.entries.length; i++) {
      if (rec.entries[i].ts === ts && rec.entries[i].text === text) { idx = i; break; }
    }
    if (idx < 0) return false;
    rec.entries.splice(idx, 1);
    if (!rec.entries.length) {
      Object.keys(data.devices).forEach(function (k) {
        if (data.devices[k] === rec) delete data.devices[k];
      });
    }
    persist();
    return true;
  }

  function clearDevice(row) {
    var rec = recordFor(row);
    if (!rec) return false;
    Object.keys(data.devices).forEach(function (k) {
      if (data.devices[k] === rec) delete data.devices[k];
    });
    persist();
    return true;
  }

  function clearAll() {
    data = { version: 1, devices: {} };
    persist();
  }

  function stats() {
    var devices = 0, entries = 0;
    var seen = [];
    Object.keys(data.devices).forEach(function (k) {
      var rec = data.devices[k];
      if (seen.indexOf(rec) >= 0) return;
      seen.push(rec);
      devices++;
      entries += rec.entries.length;
    });
    return { devices: devices, entries: entries, bytes: JSON.stringify(data).length };
  }

  /* Flat rows for the audit-trail export, newest last. */
  function exportRows(rows) {
    var out = [];
    (rows || []).forEach(function (row) {
      entriesFor(row).forEach(function (e) {
        out.push({
          'Device name': row.name,
          'Asset tag': row.assetTag,
          'Serial number': row.serial,
          'Location': row.location,
          'Note added': new Date(e.ts).toLocaleString('en-GB'),
          'Added by': e.by || '',
          'Note': e.text
        });
      });
    });
    return out.sort(function (a, b) {
      return String(a['Device name']).localeCompare(String(b['Device name'])) ||
             String(a['Note added']).localeCompare(String(b['Note added']));
    });
  }

  /* For project save / restore. */
  function snapshot() { return JSON.parse(JSON.stringify(data)); }
  function restore(payload) {
    if (!payload || !payload.devices) return;
    data = payload;
    persist();
  }

  /* Merge another set in without losing either side - used when a project file
     is opened alongside notes already held in this browser. Two people working
     the same estate from a shared file must both keep their work, so this is
     a union: an entry is only skipped when the same author wrote the same text
     at the same instant, which is the same entry rather than a coincidence. */
  function merge(payload) {
    var added = 0, skipped = 0, newDevices = 0;
    if (!payload || !payload.devices) return { added: 0, skipped: 0, newDevices: 0 };

    Object.keys(payload.devices).forEach(function (k) {
      var incoming = payload.devices[k];
      if (!incoming || !incoming.entries) return;

      // Match on any identifier the incoming record carries, not just its own
      // primary key - the other person's file may key the same machine on its
      // name where this browser keys it on the serial.
      var target = null;
      (incoming.keys || [k]).forEach(function (key) {
        if (target) return;
        var primary = alias[key];
        if (primary && data.devices[primary]) target = data.devices[primary];
      });

      if (!target) {
        data.devices[k] = incoming;
        newDevices++;
        added += incoming.entries.length;
        return;
      }
      (incoming.keys || []).forEach(function (key) {
        if (target.keys.indexOf(key) < 0) target.keys.push(key);
      });
      incoming.entries.forEach(function (e) {
        var dup = target.entries.some(function (x) {
          return x.ts === e.ts && x.text === e.text && (x.by || '') === (e.by || '');
        });
        if (dup) { skipped++; return; }
        target.entries.push(e);
        added++;
      });
      target.entries.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
    });

    persist();
    return { added: added, skipped: skipped, newDevices: newDevices };
  }

  function authors() {
    var seen = {};
    Object.keys(data.devices).forEach(function (k) {
      data.devices[k].entries.forEach(function (e) {
        if (e.by) seen[e.by] = (seen[e.by] || 0) + 1;
      });
    });
    return seen;
  }

  global.Notes = {
    entriesFor: entriesFor, countFor: countFor, add: add,
    removeEntry: removeEntry, clearDevice: clearDevice, clearAll: clearAll,
    stats: stats, exportRows: exportRows, authors: authors,
    snapshot: snapshot, restore: restore, merge: merge
  };
})(window);

/* Approximate age, from a model-year lookup you maintain.

   Planning a refresh needs the one thing none of the systems record: roughly
   when each machine was built. Freshservice holds a product name, Intune holds
   a model, and neither holds a year — so the year comes from a lookup keyed on
   the model, which is how this has always been worked out by hand.

   Nothing here guesses a year. The temptation is obvious — most model names
   carry a generation, and a table of launch years could be shipped in the
   code — but the Dell OptiPlex 7010 is both a 2012 machine and a 2023 one, and
   a tool that guessed would quietly put a third of the estate in the wrong
   decade. A blank year says "look this one up"; a wrong year says nothing at
   all until somebody spends the budget. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  /* Makers, so "Dell Latitude 5440" and "Latitude 5440" are one model. Long
     forms first, or "HP" would strip the H off nothing and leave a stray
     "ewlett-Packard". */
  var MAKERS = [
    'hewlett-packard', 'hewlett packard', 'microsoft corporation', 'dell inc.',
    'dell computer corporation', 'lenovo', 'toshiba', 'fujitsu', 'samsung',
    'acer', 'asus', 'apple', 'dell', 'hp', 'msi', 'lg'
  ];

  /* Noise that the two systems disagree about on the same machine. */
  var NOISE = /\b(notebook|laptop|desktop|pc|computer|workstation|tower|sff|mt|micro|aio|all[- ]in[- ]one)\b/g;

  /* The key both sides of the lookup are reduced to.

     Deliberately not the printer module's modelKey: that one is tuned to
     printer part numbers and strips every non-alphanumeric, which would turn
     "L14 Gen 4" and "L14 Gen 40" into neighbours. Here the words matter. */
  function modelKey(v) {
    var s = N.clean(v).toLowerCase();
    if (!s) return '';
    MAKERS.forEach(function (m) {
      if (s.indexOf(m) === 0) s = s.slice(m.length);
    });
    s = s.replace(NOISE, ' ')
         .replace(/[^a-z0-9]+/g, ' ')
         .replace(/\s+/g, ' ')
         .trim();
    return s;
  }

  /* The lookup, keyed. Later rows do not overwrite earlier ones: a duplicate
     is reported rather than silently resolved, because two different years for
     one model is a question, not a preference. */
  function index(records) {
    var out = {}, duplicates = [];
    (records || []).forEach(function (r) {
      var key = modelKey(r.model);
      if (!key) return;
      var year = yearOf(r.year);
      var entry = {
        key: key,
        model: N.clean(r.model),
        year: year,
        manufacturer: N.clean(r.manufacturer),
        formFactor: N.clean(r.formFactor),
        notes: N.clean(r.notes)
      };
      if (out[key]) {
        if (out[key].year !== year) duplicates.push({ key: key, a: out[key], b: entry });
        return;
      }
      out[key] = entry;
    });
    return { byKey: out, duplicates: duplicates, count: Object.keys(out).length };
  }

  /* A year, or null. Four digits somewhere in the cell, so "2023", "FY2023"
     and "2023 (refresh)" all read the same, and anything outside living memory
     for a PC estate is a typo rather than a year. */
  function yearOf(v) {
    var m = String(v === undefined || v === null ? '' : v).match(/(19|20)\d{2}/);
    if (!m) return null;
    var y = parseInt(m[0], 10);
    var now = new Date().getFullYear();
    if (y < 1995 || y > now + 1) return null;
    return y;
  }

  /* The model a row should be looked up on.

     Freshservice's Product and Intune's Model disagree often enough that one
     of them alone loses matches, so try both. Intune first: it reads the model
     off the machine, while Freshservice holds whatever was typed when the
     asset was created. */
  function modelsFor(row) {
    var out = [];
    if (row.intune && N.clean(row.intune.model)) out.push(N.clean(row.intune.model));
    if (row.fs && N.clean(row.fs.model)) out.push(N.clean(row.fs.model));
    if (row.model && out.indexOf(N.clean(row.model)) < 0) out.push(N.clean(row.model));
    return out;
  }

  /* Put the year, the age and the band on every row. Additive: nothing already
     on the row is touched, so the reconciliation is unaffected by whether a
     lookup has been loaded. */
  function annotate(rows, lookup, cfg) {
    cfg = settings(cfg);
    var byKey = (lookup && lookup.byKey) || {};
    var now = new Date().getFullYear();

    (rows || []).forEach(function (r) {
      r.modelYear = null;
      r.modelMatched = '';
      r.modelFormFactor = '';
      r.age = null;
      r.ageBand = '';

      var names = modelsFor(r);
      for (var i = 0; i < names.length; i++) {
        var hit = byKey[modelKey(names[i])];
        if (!hit) continue;
        r.modelMatched = hit.model;
        r.modelFormFactor = hit.formFactor;
        if (hit.year) {
          r.modelYear = hit.year;
          r.age = now - hit.year;
          r.ageBand = band(r.age, cfg);
        }
        break;
      }
      if (!r.modelYear) r.ageBand = 'Unknown';
    });
    return rows;
  }

  /* Bands for grouping, built around the refresh age rather than fixed: an
     estate on a four-year cycle and one on a six-year cycle are not asking the
     same question of the same numbers. */
  function band(age, cfg) {
    cfg = settings(cfg);
    if (age === null || age === undefined) return 'Unknown';
    if (age < 0) return 'Unknown';
    if (age >= cfg.refreshYears + 2) return String(cfg.refreshYears + 2) + '+ years — overdue';
    if (age >= cfg.refreshYears) return String(cfg.refreshYears) + '–' + (cfg.refreshYears + 1) + ' years — due';
    if (age >= cfg.refreshYears - 2) return (cfg.refreshYears - 2) + '–' + (cfg.refreshYears - 1) + ' years — approaching';
    return 'Under ' + (cfg.refreshYears - 2) + ' years';
  }

  var DEFAULTS = { refreshYears: 5 };
  function settings(saved) { return Object.assign({}, DEFAULTS, saved || {}); }

  /* --------------------------------------------------- the starter list */

  /* Every distinct model in the loaded data, with how many machines carry it
     and what the two systems each call it — the file to fill in and load back.

     Built from the data rather than typed from memory, because the list of
     models in an estate is exactly the thing nobody can recall accurately and
     exactly the thing the two systems word differently. */
  function modelList(rows, lookup, cfg) {
    var seen = {};
    var byKey = (lookup && lookup.byKey) || {};

    (rows || []).forEach(function (r) {
      if (!r.inScope) return;                 // a monitor has no refresh cycle
      var names = modelsFor(r);
      if (!names.length) return;
      var key = modelKey(names[0]);
      if (!key) return;
      if (!seen[key]) {
        seen[key] = {
          key: key,
          model: names[0],
          fsNames: {}, intuneNames: {},
          makers: {},
          devices: 0,
          known: byKey[key] ? byKey[key].year : null
        };
      }
      var e = seen[key];
      e.devices++;
      if (r.fs && N.clean(r.fs.model)) e.fsNames[N.clean(r.fs.model)] = true;
      if (r.intune && N.clean(r.intune.model)) e.intuneNames[N.clean(r.intune.model)] = true;
      var make = (r.intune && N.clean(r.intune.manufacturer)) || (r.fs && N.clean(r.fs.manufacturer)) || '';
      if (make) e.makers[make] = true;
    });

    return Object.keys(seen).map(function (k) { return seen[k]; })
      .sort(function (a, b) { return b.devices - a.devices || (a.model < b.model ? -1 : 1); });
  }

  function modelListCsv(rows, lookup, cfg) {
    var headers = ['Model', 'Year', 'Manufacturer', 'Form factor', 'Devices',
                   'Called this in Freshservice', 'Called this in Intune', 'Notes'];
    var out = modelList(rows, lookup, cfg).map(function (e) {
      return {
        'Model': e.model,
        'Year': e.known === null || e.known === undefined ? '' : e.known,
        'Manufacturer': Object.keys(e.makers).sort().join(' / '),
        'Form factor': '',
        'Devices': e.devices,
        'Called this in Freshservice': Object.keys(e.fsNames).sort().join(' / '),
        'Called this in Intune': Object.keys(e.intuneNames).sort().join(' / '),
        'Notes': ''
      };
    });
    return global.CSV.stringify(out, headers);
  }

  /* How much of the estate the lookup can actually place, for the dialog. */
  function coverage(rows) {
    var scoped = (rows || []).filter(function (r) { return r.inScope; });
    var placed = scoped.filter(function (r) { return r.modelYear; });
    return {
      devices: scoped.length,
      placed: placed.length,
      unplaced: scoped.length - placed.length,
      models: Object.keys(scoped.reduce(function (a, r) {
        var k = modelKey(modelsFor(r)[0] || '');
        if (k) a[k] = true;
        return a;
      }, {})).length,
      modelsUnplaced: Object.keys(scoped.reduce(function (a, r) {
        if (r.modelYear) return a;
        var k = modelKey(modelsFor(r)[0] || '');
        if (k) a[k] = true;
        return a;
      }, {})).length
    };
  }

  global.DeviceAge = {
    DEFAULTS: DEFAULTS,
    settings: settings,
    modelKey: modelKey,
    yearOf: yearOf,
    index: index,
    annotate: annotate,
    band: band,
    modelList: modelList,
    modelListCsv: modelListCsv,
    coverage: coverage
  };
})(window);

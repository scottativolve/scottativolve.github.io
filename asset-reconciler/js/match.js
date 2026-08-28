/* Reconciliation engine: joins Freshservice, Intune, the location lookup and
   any returned verification sheets into one row per physical device. */
(function (global) {
  'use strict';

  var N = global.Norm;

  var DEFAULTS = {
    locationStrategy: 'leaf',
    staleDays: 30,          // Intune check-in older than this = stale
    fsStaleDays: 45,        // Freshservice agent audit older than this = stale
    activeDays: 14,         // checked in this recently = definitely still alive
    computerTypes: 'computer|laptop|desktop|pc|workstation|notebook|tablet|surface|macbook|imac',
    matchOnSerial: true,
    matchOnName: true
  };

  function settings(overrides) {
    return Object.assign({}, DEFAULTS, overrides || {});
  }

  function isComputer(assetType, cfg) {
    if (!assetType) return true;                 // untyped: assume in scope
    try {
      return new RegExp(cfg.computerTypes, 'i').test(assetType);
    } catch (e) {
      return true;                               // bad user regex: don't exclude
    }
  }

  /* Build an index keyed by a normalised value, recording duplicates. */
  function index(records, keyFn) {
    var map = new Map();
    var dupes = new Map();
    records.forEach(function (r) {
      var k = keyFn(r);
      if (!k) return;
      if (map.has(k)) {
        if (!dupes.has(k)) dupes.set(k, [map.get(k)]);
        dupes.get(k).push(r);
      } else {
        map.set(k, r);
      }
    });
    return { map: map, dupes: dupes };
  }

  function reconcile(data, cfg) {
    cfg = settings(cfg);
    var fsRows = (data.freshservice || []).slice();
    var inRows = (data.intune || []).slice();
    var locRows = data.locations || [];
    var verRows = data.verification || [];

    /* ------------------------------------------------ location lookup */
    var siteByKey = new Map();
    locRows.forEach(function (l) {
      var k = N.locationKey(l.location, 'full');
      if (!k) return;
      if (!siteByKey.has(k)) siteByKey.set(k, l);
      // Also index the leaf form so "Region > Site" in FS still resolves.
      var leaf = N.locationKey(l.location, 'leaf');
      if (leaf && !siteByKey.has(leaf)) siteByKey.set(leaf, l);
    });

    /* ------------------------------------------------ verification returns */
    var verByName = new Map();
    verRows.forEach(function (v) {
      var k = N.deviceName(v.name);
      if (k) verByName.set(k, v);
    });

    /* ------------------------------------------------ matching */
    var fsSerial = index(fsRows, function (r) { return cfg.matchOnSerial ? N.serial(r.serial) : ''; });
    var fsName   = index(fsRows, function (r) { return N.deviceName(r.name); });
    var inSerial = index(inRows, function (r) { return cfg.matchOnSerial ? N.serial(r.serial) : ''; });
    var inName   = index(inRows, function (r) { return N.deviceName(r.name); });

    var usedFs = new Set();
    var usedIn = new Set();
    var pairs = [];

    // Pass 1 - serial number. Strongest signal: survives a rename or rebuild.
    if (cfg.matchOnSerial) {
      fsSerial.map.forEach(function (fsRec, key) {
        var inRec = inSerial.map.get(key);
        if (inRec && !usedFs.has(fsRec) && !usedIn.has(inRec)) {
          usedFs.add(fsRec); usedIn.add(inRec);
          pairs.push({ fs: fsRec, intune: inRec, matchType: 'serial' });
        }
      });
    }

    // Pass 2 - device name.
    if (cfg.matchOnName) {
      fsName.map.forEach(function (fsRec, key) {
        if (usedFs.has(fsRec)) return;
        var inRec = inName.map.get(key);
        if (inRec && !usedIn.has(inRec)) {
          usedFs.add(fsRec); usedIn.add(inRec);
          pairs.push({ fs: fsRec, intune: inRec, matchType: 'name' });
        }
      });
    }

    // Leftovers on each side.
    fsRows.forEach(function (r) { if (!usedFs.has(r)) pairs.push({ fs: r, intune: null, matchType: 'fs-only' }); });
    inRows.forEach(function (r) { if (!usedIn.has(r)) pairs.push({ fs: null, intune: r, matchType: 'intune-only' }); });

    /* ------------------------------------------------ build rows */
    var rows = pairs.map(function (p, i) {
      var fs = p.fs, intune = p.intune;
      var name = N.clean(fs && fs.name) || N.clean(intune && intune.name) || '(unnamed)';
      var nameKey = N.deviceName(name);

      var locRaw = fs ? N.clean(fs.location) : '';
      var locName = N.location(locRaw, cfg.locationStrategy);
      var locKey = N.locationKey(locRaw, cfg.locationStrategy);
      var site = locKey ? siteByKey.get(locKey) || siteByKey.get(N.locationKey(locRaw, 'full')) || null : null;

      var fsUser = N.personDisplay(fs && fs.user, fs && fs.userEmail);
      var inUser = N.personDisplay(intune && intune.primaryUser, intune && intune.primaryUpn);
      var userStatus = N.comparePeople(
        N.clean(fs && fs.user) || N.clean(fs && fs.userEmail),
        N.clean(intune && intune.primaryUser) || N.clean(intune && intune.primaryUpn)
      );

      var lastCheckIn = intune ? global.U.parseDate(intune.lastCheckIn) : null;
      var lastAudit = fs ? global.U.parseDate(fs.lastAudit) : null;

      var assetType = N.clean(fs && fs.assetType) || (intune ? 'Computer' : '');
      var inScope = fs ? isComputer(assetType, cfg) : true;

      return {
        id: 'r' + i,
        name: name,
        nameKey: nameKey,
        serial: N.clean(fs && fs.serial) || N.clean(intune && intune.serial) || '',
        serialKey: N.serial((fs && fs.serial) || (intune && intune.serial)),
        fs: fs,
        intune: intune,
        ver: verByName.get(nameKey) || null,
        matchType: p.matchType,
        inScope: inScope,
        assetType: assetType,

        locationRaw: locRaw,
        location: locName,
        locationKey: locKey,
        site: site,
        region: site ? N.clean(site.region) : '',

        fsUser: fsUser,
        intuneUser: inUser,
        userStatus: userStatus,
        user: fsUser || inUser,

        state: N.clean(fs && fs.state),
        model: N.clean((fs && fs.model)) || N.clean(intune && intune.model),
        os: N.clean(intune && intune.os) || N.clean(fs && fs.os),
        osVersion: N.clean(intune && intune.osVersion) || N.clean(fs && fs.osVersion),
        compliance: N.clean(intune && intune.compliance),
        ownership: N.clean(intune && intune.ownership),

        lastCheckIn: lastCheckIn,
        lastAudit: lastAudit,
        lastSeen: lastCheckIn && lastAudit ? (lastCheckIn > lastAudit ? lastCheckIn : lastAudit) : (lastCheckIn || lastAudit),
        daysSinceCheckIn: lastCheckIn ? Math.floor((Date.now() - lastCheckIn) / 86400000) : null,
        daysSinceAudit: lastAudit ? Math.floor((Date.now() - lastAudit) / 86400000) : null,

        assetTag: N.clean(fs && fs.assetTag),
        department: N.clean(fs && fs.department),

        issues: [],
        severity: null,
        dupNames: 0
      };
    });

    /* Duplicate device names within a single source are worth surfacing: they
       are usually a rebuilt machine that was never retired. */
    var dupKeys = new Set();
    fsName.dupes.forEach(function (_, k) { dupKeys.add(k); });
    inName.dupes.forEach(function (_, k) { dupKeys.add(k); });
    rows.forEach(function (r) { if (dupKeys.has(r.nameKey)) r.dupNames = 1; });

    return {
      rows: rows,
      cfg: cfg,
      sites: siteByKey,
      counts: {
        fs: fsRows.length,
        intune: inRows.length,
        matched: pairs.filter(function (p) { return p.fs && p.intune; }).length,
        fsOnly: pairs.filter(function (p) { return p.fs && !p.intune; }).length,
        intuneOnly: pairs.filter(function (p) { return !p.fs && p.intune; }).length,
        bySerial: pairs.filter(function (p) { return p.matchType === 'serial'; }).length,
        byName: pairs.filter(function (p) { return p.matchType === 'name'; }).length,
        locations: locRows.length,
        verification: verRows.length
      }
    };
  }

  global.Match = { reconcile: reconcile, settings: settings, DEFAULTS: DEFAULTS, isComputer: isComputer };
})(window);

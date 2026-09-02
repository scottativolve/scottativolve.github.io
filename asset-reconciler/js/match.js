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
    matchOnName: true,
    riskScoreThreshold: 9,      // Arctic Wolf score at or above this is "high"
    risksThreshold: 500,        // this many open risks on one device is "a lot"
    scanStaleDays: 21,          // no successful scan in this long is stale
    namePrefixes: 'STD|SHR|IVOLVE|LAP|DSK'   // build prefixes that precede a serial in a device name
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
    var awRows = (data.arcticwolf || []).slice();
    var locRows = data.locations || [];
    var verRows = data.verification || [];

    /* ------------------------------------------------ location lookup */
    var siteByKey = new Map();
    var subnetIndex = [];          // [{ site, key, net }] - flat, searched linearly
    locRows.forEach(function (l) {
      var k = N.locationKey(l.location, 'full');
      if (!k) return;
      if (!siteByKey.has(k)) siteByKey.set(k, l);
      // Also index the leaf form so "Region > Site" in FS still resolves.
      var leaf = N.locationKey(l.location, 'leaf');
      if (leaf && !siteByKey.has(leaf)) siteByKey.set(leaf, l);

      global.IPNet.parseSubnetList(l.subnet).forEach(function (net) {
        subnetIndex.push({ site: l, key: k, net: net });
      });
    });

    /* Which site owns this address, if any. A few hundred subnets against a
       thousand devices is trivial to scan directly. */
    function siteForIp(ip) {
      if (!ip) return null;
      for (var i = 0; i < subnetIndex.length; i++) {
        if (global.IPNet.contains(subnetIndex[i].net, ip)) return subnetIndex[i];
      }
      return null;
    }

    /* ------------------------------------------------ vulnerability scan
       Arctic Wolf carries no serial number, so it joins on device name and,
       failing that, MAC address - which both other exports can supply. */
    function macKey(v) {
      var m = N.clean(v).toUpperCase().replace(/[^A-F0-9]/g, '');
      return m.length === 12 ? m : '';
    }

    var awByName = new Map();
    var awByMac = new Map();
    awRows.forEach(function (a) {
      var nk = N.deviceName(a.name) || N.deviceName(a.hostname);
      if (nk && !awByName.has(nk)) awByName.set(nk, a);
      var mk = macKey(a.mac);
      if (mk && !awByMac.has(mk)) awByMac.set(mk, a);
    });
    var usedAw = new Set();

    function findAw(fsRec, inRec) {
      var names = [fsRec && fsRec.name, inRec && inRec.name];
      for (var i = 0; i < names.length; i++) {
        var nk = N.deviceName(names[i]);
        var hit = nk ? awByName.get(nk) : null;
        if (hit && !usedAw.has(hit)) { usedAw.add(hit); return { rec: hit, on: 'name' }; }
      }
      var macs = [fsRec && fsRec.mac, inRec && inRec.mac];
      for (var j = 0; j < macs.length; j++) {
        var mk = macKey(macs[j]);
        var mhit = mk ? awByMac.get(mk) : null;
        if (mhit && !usedAw.has(mhit)) { usedAw.add(mhit); return { rec: mhit, on: 'mac' }; }
      }
      return null;
    }

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

    /* Leftovers. A record left over because another row in its own export
       already matched on the same serial or name is a duplicate, not a device
       the other system has never heard of - reporting it as "missing from
       Freshservice" sends someone looking for a record that is right there. */
    var matchedSerials = new Set();
    var matchedNames = new Set();
    pairs.forEach(function (p) {
      [p.fs, p.intune].forEach(function (rec) {
        if (!rec) return;
        var sk = N.serial(rec.serial);
        var nk = N.deviceName(rec.name);
        if (sk) matchedSerials.add(sk);
        if (nk) matchedNames.add(nk);
      });
    });

    function shadowed(rec) {
      var sk = N.serial(rec.serial);
      var nk = N.deviceName(rec.name);
      return (!!sk && matchedSerials.has(sk)) || (!!nk && matchedNames.has(nk));
    }

    fsRows.forEach(function (r) {
      if (usedFs.has(r)) return;
      pairs.push({ fs: r, intune: null, matchType: 'fs-only', shadowed: shadowed(r) });
    });
    inRows.forEach(function (r) {
      if (usedIn.has(r)) return;
      pairs.push({ fs: null, intune: r, matchType: 'intune-only', shadowed: shadowed(r) });
    });

    // Attach the scan to each pair before working out what is left over.
    pairs.forEach(function (p) {
      var hit = findAw(p.fs, p.intune);
      if (hit) { p.aw = hit.rec; p.awOn = hit.on; }
    });
    awRows.forEach(function (a) {
      if (usedAw.has(a)) return;
      pairs.push({ fs: null, intune: null, aw: a, matchType: 'aw-only' });
    });

    /* ------------------------------------------------ build rows */
    var rows = pairs.map(function (p, i) {
      var fs = p.fs, intune = p.intune, aw = p.aw || null;
      var name = N.clean(fs && fs.name) || N.clean(intune && intune.name) ||
                 N.clean(aw && aw.name) || N.clean(aw && aw.hostname) || '(unnamed)';
      var nameKey = N.deviceName(name);

      var locRaw = fs ? N.clean(fs.location) : '';
      var locName = N.location(locRaw, cfg.locationStrategy);
      var locKey = N.locationKey(locRaw, cfg.locationStrategy);
      var site = locKey ? siteByKey.get(locKey) || siteByKey.get(N.locationKey(locRaw, 'full')) || null : null;

      /* "Last login by" is the Windows logon name the discovery agent read off
         the machine, not a Freshservice identity - so it is the best evidence
         of who actually uses the device, but a poor value to write back. */
      var lastLoginBy = N.clean(fs && fs.lastLoginBy);
      var fsUser = N.personDisplay(fs && fs.user, fs && fs.userEmail);
      var inUser = N.personDisplay(intune && intune.primaryUser, intune && intune.primaryUpn);
      var loginVsAssigned = lastLoginBy
        ? N.comparePeople(lastLoginBy, N.clean(fs && fs.user) || N.clean(fs && fs.userEmail))
        : 'unknown';
      var loginVsIntune = lastLoginBy && intune
        ? N.comparePeople(lastLoginBy, N.clean(intune.primaryUser) || N.clean(intune.primaryUpn))
        : 'unknown';

      var userStatus = N.comparePeople(
        N.clean(fs && fs.user) || N.clean(fs && fs.userEmail),
        N.clean(intune && intune.primaryUser) || N.clean(intune && intune.primaryUpn)
      );

      var lastCheckIn = intune ? global.U.parseDate(intune.lastCheckIn) : null;
      var lastAudit = fs ? global.U.parseDate(fs.lastAudit) : null;

      var assetType = N.clean(fs && fs.assetType) ||
                      (intune ? 'Computer' : N.clean(aw && aw.category));
      var inScope = fs ? isComputer(assetType, cfg) : true;

      /* Last-seen IP. Both systems record one; the useful one is whichever
         system saw the device most recently, since that is the address that
         says where it is now. */
      var awLastSeen = aw ? global.U.parseDate(aw.lastSeen) : null;
      var awLastScan = aw ? global.U.parseDate(aw.lastScan) : null;

      var sightings = [
        { ip: global.IPNet.primary(fs && fs.ipAddress), at: lastAudit, from: 'Freshservice' },
        { ip: global.IPNet.primary(intune && intune.ipAddress), at: lastCheckIn, from: 'Intune' },
        { ip: global.IPNet.primary(aw && aw.ipAddress), at: awLastSeen, from: 'Arctic Wolf' }
      ].filter(function (x) { return x.ip; });

      // Most recently seen wins; an address with no timestamp only counts when
      // nothing better is on offer.
      sightings.sort(function (a, b) {
        if (a.at && b.at) return b.at - a.at;
        if (a.at) return -1;
        if (b.at) return 1;
        return 0;
      });
      var ip = sightings.length ? sightings[0].ip : '';
      var ipFrom = sightings.length ? sightings[0].from : '';
      var fsIp = global.IPNet.primary(fs && fs.ipAddress);
      var inIp = global.IPNet.primary(intune && intune.ipAddress);

      var ipClass = ip ? global.IPNet.classify(ip) : '';
      var ipHit = siteForIp(ip);
      var ipSite = ipHit ? ipHit.site : null;
      var ipSiteKey = ipHit ? ipHit.key : '';

      /* ipStatus:
           ''             no address to judge by
           'no-subnets'   nothing in the lookup has a subnet, so nothing to check
           'match'        the address sits in the assigned site's own range
           'other-site'   it sits in a different site's range
           'suggests'     Freshservice has no usable location but the IP names one
           'unassigned'   the assigned site has no subnet recorded
           'off-network'  a private or home address in none of the known ranges */
      var ipStatus = '';
      var assignedHasSubnet = site ? global.IPNet.parseSubnetList(site.subnet).length > 0 : false;

      if (!ip) ipStatus = '';
      else if (!subnetIndex.length) ipStatus = 'no-subnets';
      else if (ipSite && site && ipSiteKey === locKey) ipStatus = 'match';
      else if (ipSite && site) ipStatus = 'other-site';
      else if (ipSite && !site) ipStatus = 'suggests';
      else if (site && !assignedHasSubnet) ipStatus = 'unassigned';
      else ipStatus = 'off-network';

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
        shadowed: !!p.shadowed,
        inScope: inScope,
        assetType: assetType,

        locationRaw: locRaw,
        location: locName,
        locationKey: locKey,
        site: site,
        region: site ? N.clean(site.region) : '',

        fsUser: fsUser,
        intuneUser: inUser,
        lastLoginBy: lastLoginBy,
        loginVsAssigned: loginVsAssigned,
        loginVsIntune: loginVsIntune,
        userStatus: userStatus,
        user: fsUser || inUser,

        state: N.clean(fs && fs.state),
        model: N.clean((fs && fs.model)) || N.clean(intune && intune.model),
        os: N.clean(intune && intune.os) || N.clean(fs && fs.os),
        osVersion: N.clean(intune && intune.osVersion) || N.clean(fs && fs.osVersion),
        compliance: N.clean(intune && intune.compliance),
        ownership: N.clean(intune && intune.ownership),

        aw: aw,
        awOn: p.awOn || '',
        riskScore: aw && typeof aw.riskScore === 'number' ? aw.riskScore : null,
        risks: aw && typeof aw.risks === 'number' ? aw.risks : null,
        awLastScan: awLastScan,
        awLastSeen: awLastSeen,
        awCriticality: N.clean(aw && aw.criticality),
        awCategory: N.clean(aw && aw.category),
        awState: N.clean(aw && aw.state),
        daysSinceScan: awLastScan ? Math.floor((Date.now() - awLastScan) / 86400000) : null,

        ip: ip,
        ipFrom: ipFrom,
        ipClass: ipClass,
        ipSite: ipSite,
        ipSiteName: ipSite ? N.clean(ipSite.location) : '',
        ipSiteKey: ipSiteKey,
        ipSubnet: ipHit ? global.IPNet.describe(ipHit.net) : '',
        ipStatus: ipStatus,
        fsIp: fsIp,
        intuneIp: inIp,

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
        verification: verRows.length,
        arcticWolf: awRows.length,
        awMatched: pairs.filter(function (p) { return p.aw && (p.fs || p.intune); }).length,
        awOnly: pairs.filter(function (p) { return p.matchType === 'aw-only'; }).length,
        awByMac: pairs.filter(function (p) { return p.awOn === 'mac'; }).length,
        sitesWithSubnet: locRows.filter(function (l) {
          return global.IPNet.parseSubnetList(l.subnet).length > 0;
        }).length,
        subnets: subnetIndex.length
      }
    };
  }

  global.Match = { reconcile: reconcile, settings: settings, DEFAULTS: DEFAULTS, isComputer: isComputer };
})(window);

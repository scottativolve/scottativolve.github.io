/* Canonical field definitions plus the column auto-mapper.

   Export column names drift between Freshservice/Intune versions and between
   tenants, so nothing here is hard-coded into the engine: every field is
   resolved through a mapping the user can inspect and override. */
(function (global) {
  'use strict';

  var SOURCES = {
    freshservice: {
      id: 'freshservice',
      label: 'Freshservice',
      short: 'FS',
      hint: 'Assets export (Assets → Export → CSV)',
      signature: ['asset tag', 'used by', 'asset state', 'asset type', 'display name', 'last audit date', 'display id', 'usage type'],
      fields: [
        { key: 'name',         label: 'Device name',      required: true,  aliases: ['display name', 'name', 'asset name', 'device name', 'hostname', 'host name', 'computer name', 'machine name'] },
        { key: 'assetTag',     label: 'Asset tag',        aliases: ['asset tag', 'asset id', 'tag', 'asset code'] },
        { key: 'displayId',    label: 'Display ID',       aliases: ['display id', 'asset display id', 'id'] },
        { key: 'serial',       label: 'Serial number',    aliases: ['serial number', 'serial no', 'serial', 'serialnumber', 'service tag'] },
        { key: 'assetType',    label: 'Asset type',       aliases: ['asset type', 'asset type name', 'product type', 'type', 'ci type'] },
        { key: 'state',        label: 'Asset state',      aliases: ['asset state', 'state', 'status', 'usage type', 'asset status'] },
        { key: 'user',         label: 'Assigned user',    aliases: ['used by', 'assigned to', 'assigned user', 'user', 'owner', 'used by name', 'end user'] },
        { key: 'userEmail',    label: 'User email',       aliases: ['used by email', 'user email', 'email', 'assigned to email', 'primary email'] },
        { key: 'lastLoginBy',  label: 'Last login by',    aliases: ['last login by', 'last logged in user', 'last logon user', 'logged in user', 'last login', 'windows logon name', 'last login user'] },
        { key: 'location',     label: 'Location',         aliases: ['location', 'location name', 'site', 'site name', 'service'] },
        { key: 'department',   label: 'Department',       aliases: ['department', 'department name', 'business unit'] },
        { key: 'model',        label: 'Model',            aliases: ['product', 'model', 'product name', 'asset model'] },
        { key: 'manufacturer', label: 'Manufacturer',     aliases: ['vendor', 'manufacturer', 'make', 'vendor name'] },
        { key: 'os',           label: 'Operating system', aliases: ['os', 'operating system', 'os name'] },
        { key: 'osVersion',    label: 'OS version',       aliases: ['os version', 'operating system version', 'os service pack'] },
        { key: 'ipAddress',    label: 'Last seen IP address', aliases: ['ip address', 'last seen ip', 'last known ip', 'ip', 'ipv4 address', 'ipv4', 'private ip', 'network ip', 'host ip'] },
        { key: 'mac',          label: 'MAC address',      aliases: ['mac address', 'mac', 'physical address', 'ethernet mac'] },
        { key: 'lastAudit',    label: 'Last audit / seen',type: 'date', aliases: ['last audit date', 'last audit', 'last seen', 'agent last contacted', 'last contacted', 'last scan'] },
        { key: 'createdAt',    label: 'Created',          type: 'date', aliases: ['created time', 'created at', 'created date', 'created', 'acquisition date'] },
        { key: 'description',  label: 'Description',      aliases: ['description', 'notes', 'comments'] }
      ]
    },

    intune: {
      id: 'intune',
      label: 'Intune',
      short: 'Intune',
      hint: 'Devices export (Intune → Devices → All devices → Export)',
      signature: ['compliance', 'last check-in', 'primary user upn', 'enrollment date', 'managed by', 'ownership', 'intune device id', 'azure ad device id', 'device name', 'jailbroken'],
      fields: [
        { key: 'name',         label: 'Device name',      required: true, aliases: ['device name', 'devicename', 'name', 'managed device name', 'host name', 'hostname', 'computer name'] },
        { key: 'serial',       label: 'Serial number',    aliases: ['serial number', 'serialnumber', 'serial', 'device serial number'] },
        { key: 'primaryUser',  label: 'Primary user',     aliases: ['primary user display name', 'primary user', 'user display name', 'user name', 'username', 'owner', 'user'] },
        { key: 'primaryUpn',   label: 'Primary user UPN', aliases: ['primary user upn', 'upn', 'user principal name', 'userprincipalname', 'primary user email address', 'primary user email', 'email'] },
        { key: 'os',           label: 'Operating system', aliases: ['os', 'operating system', 'osdescription', 'platform'] },
        { key: 'osVersion',    label: 'OS version',       aliases: ['os version', 'osversion', 'operating system version'] },
        { key: 'model',        label: 'Model',            aliases: ['model', 'device model', 'systemmodel'] },
        { key: 'manufacturer', label: 'Manufacturer',     aliases: ['manufacturer', 'systemmanufacturer', 'make'] },
        { key: 'ipAddress',    label: 'Last seen IP address', aliases: ['ip address', 'last seen ip', 'wi-fi ip address', 'wifi ip address', 'ipv4 address', 'ipv4', 'ip', 'public ip', 'private ip'] },
        { key: 'mac',          label: 'MAC address',      aliases: ['mac address', 'mac', 'wi-fi mac', 'ethernet mac', 'physical address'] },
        { key: 'lastCheckIn',  label: 'Last check-in',    type: 'date', aliases: ['last check-in', 'last check in', 'lastcheckin', 'last sync', 'lastsyncdatetime', 'last contact', 'last contacted', 'last check-in time'] },
        { key: 'enrolled',     label: 'Enrolled',         type: 'date', aliases: ['enrollment date', 'enrolled date', 'enrolleddatetime', 'enrolment date', 'enrolled'] },
        { key: 'compliance',   label: 'Compliance',       aliases: ['compliance', 'compliance state', 'compliancestate', 'compliant'] },
        { key: 'ownership',    label: 'Ownership',        aliases: ['ownership', 'owner type', 'ownertype', 'managed by'] },
        { key: 'category',     label: 'Category',         aliases: ['category', 'device category', 'devicecategory'] },
        { key: 'deviceId',     label: 'Intune device ID', aliases: ['intune device id', 'device id', 'deviceid', 'azure ad device id', 'entra device id', 'id'] },
        { key: 'encrypted',    label: 'Encrypted',        aliases: ['encrypted', 'encryption', 'bitlocker'] }
      ]
    },

    arcticwolf: {
      id: 'arcticwolf',
      label: 'Arctic Wolf',
      short: 'Arctic Wolf',
      hint: 'Vulnerability scan export (risk score and risk counts)',
      signature: ['risk score', 'risks', 'asset criticality', 'last successful scan', 'low signal', 'netbios'],
      fields: [
        { key: 'name',        label: 'Device name',      required: true, aliases: ['device name', 'hostname', 'asset name', 'name', 'netbios'] },
        { key: 'hostname',    label: 'Hostname',         aliases: ['hostname', 'host name', 'fqdn'] },
        { key: 'riskScore',   label: 'Risk score',       type: 'number', aliases: ['risk score', 'score', 'highest risk score', 'max risk score'] },
        { key: 'risks',       label: 'Number of risks',  type: 'number', aliases: ['risks', 'risk count', 'number of risks', 'vulnerabilities', 'vulnerability count', 'open risks'] },
        { key: 'lastScan',    label: 'Last successful scan', type: 'date', aliases: ['last successful scan', 'last scan', 'last scan date', 'last successful scan date'] },
        { key: 'lastSeen',    label: 'Last seen',        type: 'date', aliases: ['last seen', 'last seen date', 'last contact'] },
        { key: 'ipAddress',   label: 'IP address(es)',   aliases: ['ip addresses', 'ip address', 'ip', 'ipv4 address'] },
        { key: 'mac',         label: 'MAC address',      aliases: ['mac address', 'mac', 'physical address'] },
        { key: 'assetId',     label: 'Arctic Wolf asset ID', aliases: ['asset id', 'id', 'uuid'] },
        { key: 'state',       label: 'Asset state',      aliases: ['asset state', 'state', 'status'] },
        { key: 'criticality', label: 'Asset criticality',aliases: ['asset criticality', 'criticality', 'business criticality'] },
        { key: 'category',    label: 'Category',         aliases: ['category', 'device category', 'asset category', 'device type'] },
        { key: 'os',          label: 'Operating system', aliases: ['operating system', 'os'] },
        { key: 'osType',      label: 'OS type',          aliases: ['os type', 'platform', 'ostype'] },
        { key: 'sources',     label: 'Scan source',      aliases: ['sources', 'source', 'discovered by'] },
        { key: 'tags',        label: 'Tags',             aliases: ['tags', 'tag', 'labels'] },
        { key: 'lowSignal',   label: 'Low signal',       aliases: ['low signal', 'lowsignal'] }
      ]
    },

    fortimanager: {
      id: 'fortimanager',
      label: 'FortiManager',
      short: 'Forti',
      hint: 'Managed devices export (Device Manager \u2192 Table View \u2192 Export). Drop both environments here.',
      multi: true,
      signature: ['config status', 'policy package status', 'fortiguard license', 'provisioning templates',
                  'management mode', 'controller counter', 'fgsp', 'ha status'],
      anti: ['compliance', 'primary user upn', 'enrollment date', 'asset state', 'used by'],
      fields: [
        { key: 'name',        label: 'Device name',    required: true, aliases: ['device name', 'name'] },
        { key: 'serial',      label: 'Serial number',  aliases: ['serial number', 'serial'] },
        { key: 'platform',    label: 'Platform',       aliases: ['platform', 'model', 'device model'] },
        { key: 'firmware',    label: 'Firmware version', aliases: ['firmware version', 'firmware', 'os version'] },
        { key: 'hostName',    label: 'Host name',      aliases: ['host name', 'hostname'] },
        { key: 'haStatus',    label: 'HA status',      aliases: ['ha status', 'ha', 'cluster status'] },
        { key: 'configStatus',label: 'Config status',  aliases: ['config status', 'configuration status'] },
        { key: 'ipAddress',   label: 'IP address',     aliases: ['ip address', 'ip', 'wan ip', 'external ip', 'ipv4 address'] },
        { key: 'description', label: 'Description',    aliases: ['description', 'comments', 'notes'] },
        { key: 'controllers', label: 'Controller counter', aliases: ['controller counter', 'controllers'] },
        { key: 'mgmtMode',    label: 'Management mode',aliases: ['management mode', 'managed mode'] },
        { key: 'policyPkg',   label: 'Policy package status', aliases: ['policy package status', 'policy package'] },
        { key: 'fortiguard',  label: 'FortiGuard licence', aliases: ['fortiguard license', 'fortiguard licence', 'fortiguard'] },
        { key: 'upgrade',     label: 'Upgrade status', aliases: ['upgrade status'] },
        { key: 'fwTemplate',  label: 'Firmware template', aliases: ['firmware template'] },
        { key: 'provisioning',label: 'Provisioning templates', aliases: ['provisioning templates'] },
        { key: 'fabric',      label: 'Fabric member',  aliases: ['fabric member', 'security fabric'] },
        { key: 'autoLink',    label: 'Auto-link status', aliases: ['auto link status', 'autolink status'] },
        { key: 'sdwan',       label: 'Managed by SD-WAN Manager', aliases: ['managed by sd wan manager', 'managed by sdwan manager'] },
        { key: 'address',     label: 'Address',        aliases: ['address device', 'address'] }
      ]
    },

    fsnetwork: {
      id: 'fsnetwork',
      label: 'Freshservice network',
      short: 'FS net',
      hint: 'Network assets export (routers, switches, access points)',
      signature: ['physical subtype', 'virtual subtype', 'availability zone', 'ports',
                  'subnet mask', 'discovery enabled', 'book value'],
      anti: ['last login by', 'used by email', 'operating system', 'compliance', 'jailbroken', 'config status'],
      fields: [
        { key: 'name',        label: 'Device name',    required: true, aliases: ['name', 'display name', 'device name', 'hostname', 'asset name'] },
        { key: 'serial',      label: 'Serial number',  aliases: ['serial number', 'serial no', 'serial'] },
        { key: 'assetTag',    label: 'Asset tag',      aliases: ['asset tag', 'asset id', 'tag'] },
        { key: 'assetType',   label: 'Asset type',     aliases: ['asset type', 'asset type name', 'ci type'] },
        { key: 'ciType',      label: 'Type',           aliases: ['type'] },
        { key: 'subtype',     label: 'Physical subtype', aliases: ['physical subtype', 'subtype'] },
        { key: 'state',       label: 'Asset state',    aliases: ['asset state', 'state', 'asset status'] },
        { key: 'usageType',   label: 'Usage type',     aliases: ['usage type'] },
        { key: 'location',    label: 'Location',       aliases: ['location', 'location name', 'site'] },
        { key: 'department',  label: 'Department',     aliases: ['department', 'department name'] },
        { key: 'product',     label: 'Product',        aliases: ['product', 'product name', 'model'] },
        { key: 'vendor',      label: 'Vendor',         aliases: ['vendor', 'manufacturer', 'make'] },
        { key: 'firmware',    label: 'Firmware',       aliases: ['firmware'] },
        { key: 'firmwareVersion', label: 'Firmware version', aliases: ['firmware version'] },
        { key: 'ipAddress',   label: 'IP address',     aliases: ['ip address', 'ip', 'ipv4 address'] },
        { key: 'mac',         label: 'MAC address',    aliases: ['mac address', 'mac', 'physical address'] },
        { key: 'subnetMask',  label: 'Subnet mask',    aliases: ['subnet mask', 'netmask'] },
        { key: 'ports',       label: 'Ports',          aliases: ['ports', 'port count'] },
        { key: 'domain',      label: 'Domain',         aliases: ['domain'] },
        { key: 'workspace',   label: 'Workspace',      aliases: ['workspace'] },
        { key: 'lastAudit',   label: 'Last audit',     type: 'date', aliases: ['last audit date', 'last audit', 'last seen'] },
        { key: 'acquired',    label: 'Acquisition date', type: 'date', aliases: ['acquisition date', 'acquired'] },
        { key: 'endOfLife',   label: 'End of life',    aliases: ['end of life', 'eol'] },
        { key: 'description', label: 'Description',    aliases: ['description', 'comments'] }
      ]
    },

    locations: {
      id: 'locations',
      label: 'Location lookup',
      short: 'Sites',
      hint: 'Your location → address list (adds the map)',
      signature: ['postcode', 'address', 'latitude', 'longitude', 'expected devices', 'post code', 'ip subnet', 'subnet', 'site code'],
      fields: [
        { key: 'location',  label: 'Location name',   required: true, aliases: ['service location name', 'location name', 'service name', 'site name', 'location', 'service', 'name'] },
        { key: 'siteCode',  label: 'Site code',       aliases: ['site code', 'code', 'site id', 'site ref', 'service code'] },
        { key: 'address',   label: 'Address',         aliases: ['address', 'full address', 'address line 1', 'street', 'address 1', 'street address'] },
        { key: 'town',      label: 'Town / city',     aliases: ['town', 'city', 'address line 2', 'locality'] },
        { key: 'postcode',  label: 'Postcode',        aliases: ['postcode', 'post code', 'zip', 'zip code', 'postal code'] },
        { key: 'subnet',    label: 'IP subnet(s)',    aliases: ['ip subnet', 'subnet', 'ip range', 'ip ranges', 'network', 'cidr', 'lan subnet', 'site subnet', 'ip address range', 'subnets'] },
        { key: 'lat',       label: 'Latitude',        type: 'number', aliases: ['latitude', 'lat', 'y'] },
        { key: 'lon',       label: 'Longitude',       type: 'number', aliases: ['longitude', 'long', 'lon', 'lng', 'x'] },
        { key: 'expected',  label: 'Expected devices',type: 'number', aliases: ['expected devices', 'expected', 'expected pcs', 'device allowance', 'allowance', 'budget', 'establishment'] },
        { key: 'region',    label: 'Region / area',   aliases: ['region', 'area', 'division', 'service area', 'operational region', 'patch', 'cluster'] },
        { key: 'siteType',  label: 'Site type',       aliases: ['site type', 'service type', 'type', 'category'] },
        { key: 'contact',   label: 'Site contact',    aliases: ['contact', 'site contact', 'manager', 'service manager', 'contact name', 'contact email'] }
      ]
    },

    verification: {
      id: 'verification',
      label: 'Verification returns',
      short: 'Returns',
      hint: 'Completed site check sheets coming back',
      signature: ['confirmed location', 'confirmed user', 'actual location', 'device present'],
      fields: [
        { key: 'name',              label: 'Device name',       required: true, aliases: ['device name', 'display name', 'name', 'hostname', 'asset name'] },
        { key: 'confirmedPresent',  label: 'Device present?',   aliases: ['device present', 'present', 'confirmed present', 'found', 'still on site'] },
        { key: 'confirmedLocation', label: 'Confirmed location',aliases: ['confirmed location', 'actual location', 'correct location', 'location'] },
        { key: 'confirmedUser',     label: 'Confirmed user',    aliases: ['confirmed user', 'actual user', 'correct user', 'used by', 'user'] },
        { key: 'confirmedState',    label: 'Confirmed status',  aliases: ['confirmed status', 'actual status', 'status', 'state'] },
        { key: 'notes',             label: 'Notes',             aliases: ['notes', 'comments', 'note', 'comment'] }
      ]
    }
  };

  function normHeader(h) {
    return String(h || '').toLowerCase()
      .replace(/[‐-―]/g, '-')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /* Score how well a header matches one alias. 0 = no match. */
  function scoreAlias(header, alias) {
    var h = normHeader(header);
    var a = normHeader(alias);
    if (!h || !a) return 0;
    if (h === a) return 100;

    var hc = h.replace(/ /g, ''), ac = a.replace(/ /g, '');
    if (hc === ac) return 95;

    // Header is the alias plus a qualifier: "Serial Number (Device)".
    // Both tests must be a real hit: indexOf returns -1 when the alias is
    // absent, and for a header the same length as the alias that -1 also
    // equals h.length - a.length - 1, which used to award 82 to a header
    // sharing nothing but its length ("Updated At" for "OS Version").
    var tailAt = h.length - a.length - 1;
    if (h.indexOf(a + ' ') === 0 || (tailAt >= 0 && h.indexOf(' ' + a) === tailAt)) {
      return 82 - Math.min(12, h.length - a.length);
    }
    /* A one- or two-character alias ("x", "y", "os", "ip") matches far too
       much as a substring: "County" contains "y", which was enough to make it
       the best candidate for Latitude. Short aliases have to match a whole
       word. */
    if (a.length <= 2) {
      return h.split(' ').indexOf(a) >= 0 ? 74 : 0;
    }
    if (h.indexOf(a) >= 0) return 70 - Math.min(20, h.length - a.length);
    if (a.indexOf(h) >= 0) return 58 - Math.min(20, a.length - h.length);

    // Token overlap, for wording differences like "Date last seen".
    var ht = h.split(' ').filter(Boolean), at = a.split(' ').filter(Boolean);
    var shared = at.filter(function (t) { return ht.indexOf(t) >= 0; }).length;
    if (!shared) return 0;
    var cover = shared / Math.max(ht.length, at.length);
    return cover >= 0.6 ? Math.round(30 + cover * 20) : 0;
  }

  function scoreField(header, field) {
    var best = 0;
    field.aliases.forEach(function (a, i) {
      // Earlier aliases are the canonical export names, so nudge them ahead
      // of the later fallbacks when two score the same.
      var s = scoreAlias(header, a) - i * 0.5;
      if (s > best) best = s;
    });
    return best;
  }

  /* Globally greedy assignment: build every (field, header) score, then take
     the strongest pair repeatedly. Beats field-order matching, which lets an
     early loose field like "Name" steal "Location Name". */
  function autoMap(sourceId, headers) {
    var src = SOURCES[sourceId];
    if (!src) return {};
    var pairs = [];
    src.fields.forEach(function (f) {
      headers.forEach(function (h) {
        var s = scoreField(h, f);
        if (s >= 40) pairs.push({ field: f.key, header: h, score: s });
      });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });

    var mapping = {}, usedHeaders = {}, usedFields = {};
    pairs.forEach(function (p) {
      if (usedFields[p.field] || usedHeaders[p.header]) return;
      mapping[p.field] = p.header;
      usedFields[p.field] = true;
      usedHeaders[p.header] = true;
    });
    return mapping;
  }

  /* Which of the four kinds of file is this? Used so a user can drop several
     exports at once without saying which is which. */
  function detectSource(headers) {
    var scores = {};
    Object.keys(SOURCES).forEach(function (id) {
      var src = SOURCES[id];
      var hit = 0;
      src.signature.forEach(function (sig) {
        var matched = headers.some(function (h) { return scoreAlias(h, sig) >= 90; });
        if (matched) hit += 1;
      });
      // Two exports of the same population can share most of their headers —
      // the Freshservice PC and network exports do — so positive signals alone
      // cannot separate them. anti lists headers that rule a source out.
      var miss = 0;
      (src.anti || []).forEach(function (sig) {
        var matched = headers.some(function (h) { return scoreAlias(h, sig) >= 90; });
        if (matched) miss += 1;
      });
      // Fraction of required fields we could map at all.
      var mapping = autoMap(id, headers);
      var req = src.fields.filter(function (f) { return f.required; });
      var reqOk = req.every(function (f) { return mapping[f.key]; }) ? 1 : 0;
      var coverage = Object.keys(mapping).length / src.fields.length;
      scores[id] = hit * 3 + reqOk * 2 + coverage * 2 - miss * 4;
    });

    var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; });
    var bestId = ranked[0], bestScore = scores[bestId];
    var runnerUp = ranked.length > 1 ? scores[ranked[1]] : 0;
    // A file the FortiManager export could be mistaken for is worse than a
    // file we admit we cannot place: loading 800 network devices as Intune
    // devices would corrupt the PC reconciliation silently.
    var confident = bestScore >= 6 && bestScore - runnerUp >= 2;
    return { source: confident ? bestId : null, scores: scores };
  }

  function fieldsOf(sourceId) { return (SOURCES[sourceId] || { fields: [] }).fields; }

  function fieldDef(sourceId, key) {
    return fieldsOf(sourceId).filter(function (f) { return f.key === key; })[0] || null;
  }

  /* Turn raw rows into canonical records using the mapping. */
  function project(sourceId, rows, mapping) {
    var fields = fieldsOf(sourceId);
    return rows.map(function (raw, i) {
      var rec = { _row: i + 2, _raw: raw };
      fields.forEach(function (f) {
        var header = mapping[f.key];
        var v = header ? raw[header] : '';
        v = v === undefined || v === null ? '' : String(v).trim();
        if (f.type === 'number' && v !== '') {
          var n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
          rec[f.key] = isNaN(n) ? null : n;
        } else {
          rec[f.key] = v;
        }
      });
      return rec;
    });
  }

  /* A mapping that came out of storage was written by whatever build saved it,
     so it says nothing about fields added to the tool since. Left alone, those
     fields stay unmapped for ever and their columns are silently blank while
     everything else works.

     Fill only the genuine gaps: a field the mapping already names is left
     exactly as it is, a field the saving build knew about and deliberately left
     unmapped stays unmapped, and a suggestion is ignored if another field has
     already claimed that column. */
  function fillMapping(sourceId, headers, mapping, knownFields) {
    var out = Object.assign({}, mapping || {});
    var auto = autoMap(sourceId, headers);
    var filled = [];

    var claimed = {};
    Object.keys(out).forEach(function (k) { if (out[k]) claimed[out[k]] = true; });

    fieldsOf(sourceId).forEach(function (f) {
      if (out[f.key]) return;                                  // already decided
      if (knownFields && knownFields.indexOf(f.key) >= 0) return;  // knowingly left out
      var suggestion = auto[f.key];
      if (!suggestion || claimed[suggestion]) return;
      out[f.key] = suggestion;
      claimed[suggestion] = true;
      filled.push({ key: f.key, label: f.label, header: suggestion });
    });

    return { mapping: out, filled: filled };
  }

  function fieldKeys(sourceId) {
    return fieldsOf(sourceId).map(function (f) { return f.key; });
  }

  global.Schema = {
    fillMapping: fillMapping,
    fieldKeys: fieldKeys,
    SOURCES: SOURCES,
    autoMap: autoMap,
    detectSource: detectSource,
    fieldsOf: fieldsOf,
    fieldDef: fieldDef,
    project: project,
    normHeader: normHeader,
    scoreField: scoreField
  };
})(window);

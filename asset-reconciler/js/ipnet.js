/* IPv4 address and subnet handling for locating a device by the network it
   was last seen on.

   IPv6 is deliberately ignored rather than half-supported: the site subnets
   people maintain are v4, and an Intune export that carries a v6 address
   alongside a v4 one should be read on the v4. */
(function (global) {
  'use strict';

  var V4 = /(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/g;

  function toInt(ip) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
    if (!m) return null;
    var parts = [+m[1], +m[2], +m[3], +m[4]];
    for (var i = 0; i < 4; i++) if (parts[i] > 255) return null;
    // >>> 0 keeps it unsigned; a leading octet above 127 would otherwise go negative.
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  function toStr(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }

  function isValid(ip) { return toInt(ip) !== null; }

  /* Classify an address so the tool can tell "somewhere else on our network"
     from "someone's home router". */
  function classify(ip) {
    var n = toInt(ip);
    if (n === null) return 'invalid';
    if (n >>> 24 === 127) return 'loopback';
    if ((n >>> 16) === 0xA9FE) return 'link-local';        // 169.254/16, failed DHCP
    if (n >>> 24 === 10) return 'private';                  // 10/8
    if ((n >>> 20) === 0xAC1) return 'private';             // 172.16/12
    if ((n >>> 16) === 0xC0A8) return 'home';               // 192.168/16
    if ((n >>> 22) === 0x19040) return 'cgnat';             // 100.64/10
    if (n === 0) return 'invalid';
    return 'public';
  }

  /* Is this an address worth reasoning about at all? */
  function isUsable(ip) {
    var c = classify(ip);
    return c !== 'invalid' && c !== 'loopback' && c !== 'link-local';
  }

  /* Pull the addresses out of a cell that may hold several, in any of the
     shapes the two exports use ("10.1.2.3", "10.1.2.3; 169.254.0.1",
     "10.1.2.3 / fe80::1"). Unusable ones are dropped. */
  function extract(cell) {
    if (!cell) return [];
    var found = String(cell).match(V4) || [];
    var seen = {};
    return found.filter(function (ip) {
      if (!isValid(ip) || !isUsable(ip) || seen[ip]) return false;
      seen[ip] = true;
      return true;
    });
  }

  /* The address most worth judging a device's location by: a corporate private
     range beats a home range, which beats anything else. */
  function primary(cell) {
    var ips = extract(cell);
    if (!ips.length) return '';
    var rank = { 'private': 0, 'cgnat': 1, 'home': 2, 'public': 3 };
    ips.sort(function (a, b) {
      return (rank[classify(a)] === undefined ? 9 : rank[classify(a)]) -
             (rank[classify(b)] === undefined ? 9 : rank[classify(b)]);
    });
    return ips[0];
  }

  /* ------------------------------------------------------------ subnets */

  function maskToBits(mask) {
    var n = toInt(mask);
    if (n === null) return null;
    var bits = 0, seenZero = false;
    for (var i = 31; i >= 0; i--) {
      if ((n >>> i) & 1) {
        if (seenZero) return null;                 // non-contiguous mask
        bits++;
      } else seenZero = true;
    }
    return bits;
  }

  /* Accepts CIDR (10.1.2.0/24), a dotted mask (10.1.2.0/255.255.255.0), a
     wildcard (10.1.2.*), a range (10.1.2.10-10.1.2.50 or 10.1.2.10-50), or a
     bare network address, which is read as a /24 - the shape most site lists
     are written in. Returns {start, end, label} or null. */
  function parseSubnet(spec) {
    var s = String(spec || '').trim();
    if (!s) return null;

    // range
    var range = /^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3}|\d{1,3})$/.exec(s);
    if (range) {
      var a = toInt(range[1]);
      if (a === null) return null;
      var b;
      if (range[2].indexOf('.') >= 0) b = toInt(range[2]);
      else b = (a & 0xFFFFFF00) >>> 0 | (+range[2] & 255);   // short form: last octet only
      if (b === null || b < a) return null;
      return { start: a >>> 0, end: b >>> 0, label: s };
    }

    // wildcard
    if (s.indexOf('*') >= 0) {
      var octets = s.split('.');
      if (octets.length !== 4) return null;
      var lo = [], hi = [];
      for (var i = 0; i < 4; i++) {
        if (octets[i].trim() === '*') { lo.push(0); hi.push(255); }
        else {
          var v = parseInt(octets[i], 10);
          if (isNaN(v) || v > 255) return null;
          lo.push(v); hi.push(v);
        }
      }
      var ls = toInt(lo.join('.')), hs = toInt(hi.join('.'));
      if (ls === null || hs === null) return null;
      return { start: ls, end: hs, label: s };
    }

    // cidr or dotted mask
    var slash = s.split('/');
    var base = toInt(slash[0]);
    if (base === null) return null;

    var bits;
    if (slash.length === 1) bits = 24;                        // bare network
    else if (slash[1].indexOf('.') >= 0) bits = maskToBits(slash[1]);
    else {
      bits = parseInt(slash[1], 10);
      if (isNaN(bits)) bits = null;
    }
    if (bits === null || bits < 0 || bits > 32) return null;

    var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    var start = (base & mask) >>> 0;
    var end = (start | (~mask >>> 0)) >>> 0;
    return { start: start, end: end, label: slash.length === 1 ? s + '/24' : s };
  }

  /* A site's subnet cell may list several, separated by ; , | or whitespace. */
  function parseSubnetList(cell) {
    if (!cell) return [];
    return String(cell)
      .split(/[;,|\n\r]+|\s{2,}/)
      .map(function (part) { return parseSubnet(part.trim()); })
      .filter(Boolean);
  }

  function contains(net, ip) {
    var n = toInt(ip);
    if (n === null || !net) return false;
    return n >= net.start && n <= net.end;
  }

  function anyContains(nets, ip) {
    for (var i = 0; i < (nets || []).length; i++) {
      if (contains(nets[i], ip)) return nets[i];
    }
    return null;
  }

  function describe(net) {
    if (!net) return '';
    return net.label + ' (' + toStr(net.start) + '–' + toStr(net.end) + ')';
  }

  global.IPNet = {
    toInt: toInt, toStr: toStr, isValid: isValid, isUsable: isUsable,
    classify: classify, extract: extract, primary: primary,
    parseSubnet: parseSubnet, parseSubnetList: parseSubnetList,
    contains: contains, anyContains: anyContains, describe: describe
  };
})(window);

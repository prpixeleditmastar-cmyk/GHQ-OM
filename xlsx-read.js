/* Minimal .xlsx reader (first sheet -> array of rows). Uses the browser's built-in inflate; no libraries. */
(function () {
  'use strict';
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function text(u8) { return new TextDecoder('utf-8').decode(u8); }
  function inflate(data) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This phone cannot read .xlsx — save the sheet as CSV and upload that'));
    var ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter();
    w.write(data); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (a) { return new Uint8Array(a); });
  }
  function entries(b) {
    var i = b.length - 22;
    while (i >= 0 && u32(b, i) !== 0x06054b50) i--;
    if (i < 0) throw new Error('This is not an .xlsx file');
    var n = u16(b, i + 10), off = u32(b, i + 16), out = {};
    for (var k = 0; k < n; k++) {
      if (u32(b, off) !== 0x02014b50) break;
      var nlen = u16(b, off + 28), elen = u16(b, off + 30), clen = u16(b, off + 32);
      out[text(b.subarray(off + 46, off + 46 + nlen))] = { method: u16(b, off + 10), csize: u32(b, off + 20), lho: u32(b, off + 42) };
      off += 46 + nlen + elen + clen;
    }
    return out;
  }
  function read(b, e) {
    var o = e.lho, start = o + 30 + u16(b, o + 26) + u16(b, o + 28), d = b.subarray(start, start + e.csize);
    return e.method === 0 ? Promise.resolve(d) : inflate(d);
  }
  function colIdx(ref) { var m = /^([A-Z]+)/.exec(ref); if (!m) return 0; var n = 0; for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64); return n - 1; }
  function parse(buf) {
    var b = new Uint8Array(buf), ent, shared = [];
    try { ent = entries(b); } catch (e) { return Promise.reject(e); }
    function get(name) { return ent[name] ? read(b, ent[name]).then(text) : Promise.resolve(''); }
    return get('xl/sharedStrings.xml').then(function (x) {
      if (x) {
        var si = new DOMParser().parseFromString(x, 'application/xml').getElementsByTagName('si');
        for (var i = 0; i < si.length; i++) { var ts = si[i].getElementsByTagName('t'), s = ''; for (var j = 0; j < ts.length; j++) s += ts[j].textContent; shared.push(s); }
      }
      var names = Object.keys(ent).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); })
        .sort(function (a, c) { return parseInt(a.match(/\d+/)[0], 10) - parseInt(c.match(/\d+/)[0], 10); });
      if (!names.length) throw new Error('No sheet found in the file');
      return get(names[0]);
    }).then(function (x) {
      var d = new DOMParser().parseFromString(x, 'application/xml'), rs = d.getElementsByTagName('row'), rows = [];
      for (var i = 0; i < rs.length; i++) {
        var ra = rs[i].getAttribute('r'), ri = ra ? parseInt(ra, 10) - 1 : i, cs = rs[i].getElementsByTagName('c'), row = [];
        for (var j = 0; j < cs.length; j++) {
          var c = cs[j], t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0], val = '';
          if (t === 's' && v) val = shared[+v.textContent] || '';
          else if (t === 'inlineStr') { var ts = c.getElementsByTagName('t'); for (var k = 0; k < ts.length; k++) val += ts[k].textContent; }
          else if (v) val = (t === 'str' || t === 'b' || t === 'e') ? v.textContent : Number(v.textContent);
          row[c.getAttribute('r') ? colIdx(c.getAttribute('r')) : j] = val;
        }
        rows[ri] = row;
      }
      var out = [];
      for (var r = 0; r < rows.length; r++) { var src = rows[r] || [], full = []; for (var q = 0; q < src.length; q++) full[q] = src[q] === undefined ? '' : src[q]; out.push(full); }
      return out;
    });
  }
  window.XlsxRead = { parse: parse };
})();

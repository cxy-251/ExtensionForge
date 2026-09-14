'use strict';
// Readability polish: ["ident"] -> .ident , 0xNN -> NN (outside strings). Safe, cosmetic.
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
let out = '';
let inStr = null;
for (let i = 0; i < s.length; i++) {
  const c = s[i], prev = s[i - 1];
  if (inStr) {
    out += c;
    if (c === inStr && prev !== '\\') inStr = null;
    continue;
  }
  if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
  out += c;
}
// now transforms on the code-only skeleton is tricky; simpler: regex but guard strings by tokenizing
function mapCode(code, fn) {
  let res = '', str = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], p = code[i - 1];
    if (str) { res += c; if (c === str && p !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; res += c; continue; }
    res += c;
  }
  return res;
}
// bracket-string property -> dot, only for valid identifiers and not reserved-ish edge
s = s.replace(/\["([A-Za-z_$][A-Za-z0-9_$]*)"\]/g, (w, id, off, full) => {
  // crude string guard: count unescaped quotes before offset on same line
  const lineStart = full.lastIndexOf('\n', off) + 1;
  const before = full.slice(lineStart, off);
  const dq = (before.match(/(?<!\\)"/g) || []).length;
  const sq = (before.match(/(?<!\\)'/g) || []).length;
  const bt = (before.match(/(?<!\\)`/g) || []).length;
  if (dq % 2 || sq % 2 || bt % 2) return w; // inside a string
  return '.' + id;
});
// small hex ints -> decimal (outside strings, same guard)
s = s.replace(/\b0x([0-9a-fA-F]+)\b/g, (w, hex, off, full) => {
  const lineStart = full.lastIndexOf('\n', off) + 1;
  const before = full.slice(lineStart, off);
  const dq = (before.match(/(?<!\\)"/g) || []).length;
  const sq = (before.match(/(?<!\\)'/g) || []).length;
  const bt = (before.match(/(?<!\\)`/g) || []).length;
  if (dq % 2 || sq % 2 || bt % 2) return w;
  return String(parseInt(hex, 16));
});
fs.writeFileSync(file, s, 'utf8');
console.error('polished ' + file.split(/[\\/]/).slice(-2).join('/'));

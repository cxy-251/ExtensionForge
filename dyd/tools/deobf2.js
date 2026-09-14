'use strict';
// Deobfuscator v2 for javascript-obfuscator (string-array rotation, plaintext strings).
// Strategy: run the whole module in a tolerant sandbox so the provider/decoder/rotation
// self-initialise, then pull the decoder out by name and inline every alias(<num>) call.
const fs = require('fs');
const vm = require('vm');

const infile = process.argv[2];
const outfile = process.argv[3];
let src = fs.readFileSync(infile, 'utf8');

// root decoder name = RHS of the first `const _0xAAAA = _0xBBBB;`
const firstAlias = src.match(/(?:const|let|var)\s+_0x[0-9a-fA-F]+\s*=\s*(_0x[0-9a-fA-F]+)\s*;/);
if (!firstAlias) { console.error('no alias/decoder anchor'); process.exit(2); }
const rootDec = firstAlias[1];

// tolerant everything-proxy so class defs / require / decorators don't throw
function makeTolerant() {
  const f = function () { return tolerant; };
  const tolerant = new Proxy(f, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined;
      return tolerant;
    },
    apply: () => tolerant,
    construct: () => tolerant,
    set: () => true,
    has: () => true,
  });
  return tolerant;
}
const T = makeTolerant();

const moduleObj = { exports: {} };
const sandbox = {
  require: () => T,
  module: moduleObj,
  exports: moduleObj.exports,
  console: { log(){}, error(){}, warn(){}, info(){} },
  process: process,
  parseInt, parseFloat, Math, JSON, Date, Buffer, RegExp, String, Number, Array, Object,
  setTimeout: () => 0, setInterval: () => 0, clearTimeout(){}, clearInterval(){},
  global: {}, __dirname: '', __filename: infile,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { timeout: 8000 });
} catch (e) {
  // expected: class/registration code may still blow up after decoder is defined
}
let decode = sandbox[rootDec];
if (typeof decode !== 'function') { console.error('decoder ' + rootDec + ' not in sandbox'); process.exit(3); }

// gather all identifiers that alias the decoder (transitively)
const aliases = new Set([rootDec]);
let changed = true;
while (changed) {
  changed = false;
  const re = /(?:const|let|var)\s+(_0x[0-9a-fA-F]+)\s*=\s*(_0x[0-9a-fA-F]+)\s*[;,]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (aliases.has(m[2]) && !aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
  }
}

const idAlt = [...aliases].join('|');
const callRe = new RegExp('(?:' + idAlt + ')\\s*\\(\\s*(-?0x[0-9a-fA-F]+|-?\\d+)\\s*\\)', 'g');
let count = 0;
src = src.replace(callRe, (whole, numStr) => {
  let n;
  if (/^-?0x/i.test(numStr)) n = (numStr[0] === '-' ? -1 : 1) * parseInt(numStr.replace('-', ''), 16);
  else n = parseInt(numStr, 10);
  try {
    const v = decode(n);
    if (typeof v === 'string') { count++; return JSON.stringify(v); }
  } catch (e) {}
  return whole;
});

// strip scaffolding: array provider fn, decoder fn, top rotation IIFE, alias decls
src = src.replace(/function (_0x[0-9a-fA-F]+)\s*\(\s*\)\s*\{[\s\S]*?return \1\(\);\s*\}/g, '');
src = src.replace(new RegExp('function ' + rootDec + '\\s*\\([\\s\\S]*?\\}\\s*(?=function|\\(function|const|let|var|class|module|$)'), '');
src = src.replace(/\(function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*\([^)]*\)\s*\)\s*;/, '');
src = src.replace(/(?:const|let|var)\s+(_0x[0-9a-fA-F]+)\s*=\s*(_0x[0-9a-fA-F]+)\s*;/g, (w, a) => (aliases.has(a) ? '' : w));

// light beautify
function beautify(code) {
  let out = '', depth = 0, inStr = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], prev = code[i - 1];
    if (inStr) { out += c; if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    if (c === '{') { depth++; out += '{\n' + '  '.repeat(depth); continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); out = out.replace(/[ \t]+$/, ''); if (!out.endsWith('\n')) out += '\n'; out += '  '.repeat(depth) + '}'; continue; }
    if (c === ';') { out += ';\n' + '  '.repeat(depth); continue; }
    if (c === '\n' || c === '\r') continue;
    out += c;
  }
  return out.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
}

fs.writeFileSync(outfile, beautify(src), 'utf8');
console.error(infile.split(/[\\/]/).slice(-2).join('/') + ': ' + count + ' calls inlined, ' + aliases.size + ' aliases');

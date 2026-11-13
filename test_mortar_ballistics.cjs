const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('static/mortar.js','utf8').split('(() =>')[0],ctx);
const calc=ctx.calculateMortarAim;
assert.equal(calc(500,129).aim,593);assert.equal(calc(500,-129).aim,463);
assert(calc(500,129).aim>calc(500,0).aim);assert(calc(500,-129).aim<calc(500,0).aim);
assert.equal(calc(500,null),null);assert.equal(calc(500,5000),null);assert.equal(calc(5000,0),null);
assert.equal(calc(-1,0),null);assert.equal(calc(NaN,0),null);
console.log('PASS: ballistic model, ascent/descent, unreachable targets and missing heights');

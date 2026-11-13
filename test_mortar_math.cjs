const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('static/mortar.js', 'utf8').split('(() =>')[0], context);
const calc = context.calculateMortarDistance;
const a = {x: 10000, y: 20000}, b = {x: 10300, y: 20400};
// A 3-4-5 horizontal triangle with a 12m rise is exactly 13m in 3D.
let result = calc(a, b, 100, 112);
assert.equal(result.horizontal, 5); assert.equal(result.delta, 12); assert.equal(result.distance, 13);
result = calc(a, b, 100, 88);
assert.equal(result.delta, -12); assert.equal(result.distance, 13);
assert.equal(calc(b, a, 112, 100).distance, 13);
assert.equal(calc(a, b, -20, -8).distance, 13);
assert.equal(calc(a, b, 0, 0).distance, 5);
assert.equal(calc(a, a, 0, 12).distance, 12);
assert.equal(calc(a, a, 0, 0).distance, 0);
assert.equal(calc(a, b, '100', '112').distance, 13);
for (const missing of [null, undefined, '', '  ', false, NaN, Infinity, 'bad']) {
    result = calc(a, b, 0, missing);
    assert.equal(result.horizontal, 5); assert.equal(result.distance, null); assert.equal(result.delta, null);
}
for (const coordinate of [NaN, Infinity, '100', null]) {
    assert.throws(() => calc({x: coordinate, y: 0}, b, 0, 0));
}
console.log('PASS: analytic 3-4-5-12-13 geometry, cm/m conversion, signed height, symmetry, zero/negative elevations, missing/invalid values');

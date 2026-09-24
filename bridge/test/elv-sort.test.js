// bridge/test/elv-sort.test.js
const assert = require('assert');
const { elvSortComparator } = require('../../plugin/elv-sort.js');
function ids(a) { return a.map(function (v) { return v.id; }); }

// newest: created giảm dần, null cuối
var a = [{id:'a',name:'A',created:100},{id:'b',name:'B',created:300},{id:'c',name:'C',created:null},{id:'d',name:'D',created:200}];
a.sort(elvSortComparator('newest'));
assert.deepStrictEqual(ids(a), ['b','d','a','c'], 'newest 300,200,100,null');

// oldest: created tăng dần, null cuối
var b = [{id:'a',name:'A',created:100},{id:'b',name:'B',created:300},{id:'c',name:'C',created:null},{id:'d',name:'D',created:200}];
b.sort(elvSortComparator('oldest'));
assert.deepStrictEqual(ids(b), ['a','d','b','c'], 'oldest 100,200,300,null');

// name_az không phân biệt hoa/thường
var c = [{id:'x',name:'Beta'},{id:'y',name:'alpha'},{id:'z',name:'Gamma'}];
c.sort(elvSortComparator('name_az'));
assert.deepStrictEqual(ids(c), ['y','x','z'], 'alpha,Beta,Gamma');

// name_za
var d = [{id:'x',name:'Beta'},{id:'y',name:'alpha'},{id:'z',name:'Gamma'}];
d.sort(elvSortComparator('name_za'));
assert.deepStrictEqual(ids(d), ['z','x','y'], 'Gamma,Beta,alpha');

// created bằng nhau -> tie-break theo name
var e = [{id:'p',name:'Zed',created:100},{id:'q',name:'Abe',created:100}];
e.sort(elvSortComparator('newest'));
assert.deepStrictEqual(ids(e), ['q','p'], 'created bằng -> theo name');

// mode lạ/rỗng -> coi như newest
var f = [{id:'a',name:'A',created:1},{id:'b',name:'B',created:2}];
f.sort(elvSortComparator('bogus'));
assert.deepStrictEqual(ids(f), ['b','a'], 'mode lạ -> newest');

console.log('elv-sort tests passed');

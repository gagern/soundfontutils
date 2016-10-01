/*
 * Take soundfont YAML files A and B and produce a file with
 * the semantic content of B but with the order of generators from A.
 * I.e. something that looks as much like A as possible in the text
 * but behaves exactly like B in an implementation which ignores order.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const defaults = yaml.safeLoad(
  fs.readFileSync(require.resolve("./defaults.yaml")));

function readYaml(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, "utf-8", (err, body) => {
      if (err) return reject(err);
      resolve(yaml.safeLoad(body));
    });
  });
}

function mergeDirs(a, b, c) {
  return Promise.all([
    mergeDir(a, b, c, "phdr.yml", "presets"),
    mergeDir(a, b, c, "inst.yml", "instruments"),
  ]);
}

function mergeDir(a, b, c, index, dir) {
  return readYaml(path.join(b, index))
    .then(lst => Promise.all(lst.map(itm => mergeFiles(
      path.join(a, dir, itm + ".yml"),
      path.join(b, dir, itm + ".yml"),
      path.join(c, dir, itm + ".yml")))));
}

function mergeFiles(a, b, c) {
  return Promise.all([readYaml(a), readYaml(b)])
    .then(([a, b]) => {
      if (a.zones && b.zones && a.zones.length === b.zones.length) {
        b.zones = mergeZones(a.zones, b.zones);
      }
      if (a.global && b.global) {
        b.global = mergeZone(a.global, b.global);
      }
      return b;
    })
    .then(data => new Promise((resolve, reject) => {
      fs.writeFile(c, yaml.safeDump(data), err => {
        if (err) return reject(err);
        resolve();
      });
    }));
}

function mergeZones(a, b) {
  const res = [];
  for (let i = 0; i < a.length; ++i) {
    res[i] = mergeZone(a[i], b[i]);
  }
  return res;
}

function mergeZone(a, b) {
  if (a.gens && b.gens) b.gens = mergeGens(a.gens, b.gens);
  if (a.mods && b.mods) b.mods = mergeMods(a.mods, b.mods);
  return b;
}

function mergeGens(a, b) {
  const res = [];
  const d = {};
  for (let kv of b) {
    const k = Object.keys(kv)[0];
    const v = kv[k];
    d[k] = v;
  }
  for (let kv of a) {
    const k = Object.keys(kv)[0];
    const v = kv[k];
    if (d.hasOwnProperty(k)) {
      // Property present in both, keep in old order
      res.push({[k]: d[k]});
      delete d[k];
    } else if (v === defaults.gens[k]) {
      // Property in old is implicit default in new, keep explicit default
      res.push(kv);
    }
  }
  for (let kv of b) {
    const k = Object.keys(kv)[0];
    const v = kv[k];
    if (d.hasOwnProperty(k) && v !== defaults.gens[k]) {
      // Property present in new at non-default value; add it to the list
      res.push(kv);
    }
  }
  return res;
}

function mergeMods(a, b) {
  return b;
}

mergeDirs(process.argv[2], process.argv[3], process.argv[4])
  .then(() => process.exit(0), err => { console.error(err); process.exit(1); });

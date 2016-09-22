"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SF2 = require("./SF2");
const defaults = yaml.safeLoad(
  fs.readFileSync(require.resolve("./defaults.yaml")));

function keyval(itm) {
  const ks = Object.keys(itm);
  if (ks.length !== 1)
    throw Error("Not a key-value pair: " + itm);
  const k = ks[0];
  const v = itm[k];
  return {k, v};
}

class YamlParse {

  constructor(dir) {
    this.dir = dir;
  }

  readFile(name) {
    return new Promise((resolve, reject) =>
      fs.readFile(path.join(this.dir, name), (err, buf) =>
        err ? reject(err) : resolve(buf)))
  }

  readYaml(name) {
    return this.readFile(name + ".yml").then(
      buf => {
        return yaml.safeLoad(buf.toString());
      },
      err => {
        if (defaults.hasOwnProperty(name) && err.code === "ENOENT")
          return defaults[name];
        throw err;
      }
    );
  }

  compile() {
    this.terminators = this.readYaml("term", defaults.term);
    this.samples = new Map();
    return this.readYaml("RIFF", defaults.RIFF)
      .then(data => this.riffDispatch("RIFF", data))
      .then(parts => Buffer.concat(parts));
  }

  sample(name) {
    if (this.samples.has(name))
      return this.samples.get(name);
    const res = this.readYaml("samples/" + name);
    this.samples.set(name, res);
    return res;
  }

  riffList(id, type, parts) {
    const bufs = [].concat.apply([], parts);
    let len = 4;
    for (let buf of bufs)
      len += buf.length;
    const head = Buffer.alloc(12, " ");
    head.write(id, 0, 4, "ascii");
    head.writeUInt32LE(len, 4);
    head.write(type, 8, 4, "ascii");
    bufs.unshift(head);
    return bufs;
  }

  riffDispatch(list, data) {
    if (typeof data === "string")
      return this["riff_" + data]();
    const {k, v} = keyval(data);
    const f = this["riff_" + k];
    if (f) return f.call(this, v, k);
    return Promise.all(v.map(itm => this.riffDispatch("LIST", itm)))
      .then(parts => this.riffList(list, k, parts));
  }

  riffChunk(id, buf) {
    if (typeof buf === "string")
      buf = Buffer.from(buf, "binary");
    const chunk = Buffer.alloc(8 + buf.length, " ");
    chunk.write(id, 0, 4, "ascii");
    chunk.writeUInt32LE(buf.length, 4);
    buf.copy(chunk, 8);
    return chunk;
  }

  riff_INFO(keys) {
    return this.readYaml("INFO").then(info => {
      const res = [];
      for (let k of keys) {
        if (!info.hasOwnProperty(k))
          continue;
        let v;
        if (k === "ifil") {
          v = Buffer.alloc(4);
          v.writeUInt16LE(info.ifil.wMajor, 0);
          v.writeUInt16LE(info.ifil.wMinor, 2);
        } else {
          v = String(info[k]);
          v += "\0".repeat(2 - (v.length & 1));
        }
        res.push(this.riffChunk(k, v));
      }
      return this.riffList("LIST", "INFO", res);
    });
  }

  riff_sdta() {
    return this._sdta || (this._sdta = this.readYaml("sdta").then(
      names => Promise.all(names.map(name => {
        if (typeof name === "string")
          return this.readWav(name)
        else
          return Promise.resolve(name)
      })).then(samples => this.sdta(samples))));
  }

  readWav(name) {
    return Promise.all([
      this.sample(name),
      this.readFile("wav/" + name + ".wav")
    ]).then(([meta, buf]) => {
      const wav = new SF2.RIFF(buf);
      const wave = wav.firstForName("WAVE");
      const fmt = wave.firstForName("fmt").data;
      const data = wave.firstForName("data").data;
      const formatTag = fmt.readUInt16LE(0);
      const channels = fmt.readUInt16LE(2);
      const sampleRate = fmt.readUInt32LE(4);
      const dataRate = fmt.readUInt32LE(8);
      const blockAlign = fmt.readUInt16LE(12);
      const bitsPerSample = fmt.readUInt16LE(14);
      const bytesPerSample = bitsPerSample >>> 3;
      if (formatTag !== 1 && formatTag !== 65534)
        throw Error("Only PCM and EXTENSIBLE is supported");
      if (channels !== 1) throw Error("Only mono samples allowed");
      if (bitsPerSample & 7) throw Error("We only deal in whole mytes");
      if (blockAlign !== channels * bytesPerSample)
        throw Error("Unexpected block alignment");
      if (dataRate !== sampleRate * blockAlign)
        throw Error("Unexpected data rate");
      if (bitsPerSample !== 16 && bitsPerSample !== 24)
        throw Error("Only 16 and 24 bit per sample allowed");
      if (bitsPerSample === 24) throw Error("24bit samples not supported yet");
      if (meta.sdta.length * blockAlign !== data.length)
        throw Error("Sample length does not match recorded metadata");
      if (formatTag === 65534) {
        const guid = fmt.toString("hex", 24, 24 + 16);
        // should be WMMEDIASUBTYPE_PCM, 00000001-0000-0010-8000-00AA00389B71
        if (guid !== "0100000000001000800000aa00389b71")
          throw Error("Only PCM subtype is supported, not " + guid);
      }
      if (bitsPerSample === 16) {
        const h = crypto.createHash("sha1");
        h.update(data);
        const d = h.digest("hex");
        if (d !== meta.sdta.smpl)
          throw Error("Sample data does not match recorded checksum");
      }
      return {
        meta,
        wav: { data },
      };
    });
  }

  sdta(lst) {
    if (lst.every(s => !s.meta.sdta || s.meta.sdta.sm24))
      return this.sdta24(lst);
    else
      return this.sdta16(lst);
  }

  sdta16(lst) {
    let gaplen = 32;
    let zeros = Buffer.alloc(2*32);
    let gap = zeros;
    const samples = [];
    let len = 0;
    for (let s of lst) {
      if (s.hasOwnProperty("gap")) {
        len += s.gap - gaplen;
        gaplen = s.gap;
        if (zeros.length < 2*gaplen) {
          zeros = gap = Buffer.alloc(2*gaplen);
        } else {
          gap = zeros.slice(0, 2*gaplen);
        }
        samples.pop();
        samples.push(gap);
        continue;
      }
      s.meta.pos = len;
      samples.push(s.wav.data, gap);
      if (s.wav.data.length !== 2*s.meta.sdta.length)
        throw Error("Length mismatch");
      len += s.meta.sdta.length + gaplen;
    }
    len *= 2;
    const head = Buffer.alloc(20);
    head.write("LIST", 0, "ascii");
    head.writeUInt32LE(len + 12, 4);
    head.write("sdta", 8, "ascii");
    head.write("smpl", 12, "ascii");
    head.writeUInt32LE(len, 16);
    samples.unshift(head);
    return samples;
  }

  sdta24(lst) {
    throw Error("Writing of the sm24 chunk isn't supported yet.");
  }

  riff_phdr() {
    return this.presets().then(data => [data.hdr]);
  }

  riff_pbag() {
    return this.presets().then(data => [data.bag]);
  }

  riff_pmod() {
    return this.presets().then(data => [data.mod]);
  }

  riff_pgen() {
    return this.presets().then(data => [data.gen]);
  }

  riff_inst() {
    return this.instruments().then(data => [data.hdr]);
  }

  riff_ibag() {
    return this.instruments().then(data => [data.bag]);
  }

  riff_imod() {
    return this.instruments().then(data => [data.mod]);
  }

  riff_igen() {
    return this.instruments().then(data => [data.gen]);
  }

  riff_shdr() {
    return this.samples1().then(data => [data.shdr]);
  }

  presets() {
    return this._pres || (this._pres = this.quad(
      "p", "phdr", "Preset", "", "presets"));
  }

  instruments() {
    return this._inst || (this._inst = this.quad(
      "i", "inst", "Inst", "Inst", "instruments"));
  }

  quad(letter, hdrName, ndx1, ndx2, dir) {
    const dict = new Map();
    return this.readYaml(hdrName)
      .then(names => Promise.all([
        this.terminators,
        Promise.all(names.map((name, i) => {
          dict.set(name, i);
          return this.readYaml(dir + "/" + name);
        })),
      ])).then(([term, lst]) => {
        let hdr = lst.slice();
        let bag = [];
        let mod = [];
        let gen = [];
        for (let i of hdr) {
          i["w" + ndx1 + "BagNdx"] = bag.length;
          if (i.global)
            bag.push(i.global);
          for (let z of i.zones)
            bag.push(z);
        }
        hdr.push(Object.assign({
          ["w" + ndx1 + "BagNdx"]: bag.length,
        }, term[hdrName]));
        for (let i of bag) {
          i["w" + ndx2 + "GenNdx"] = gen.length;
          i["w" + ndx2 + "ModNdx"] = mod.length;
          if (i.gens)
            for (let g of i.gens)
              gen.push(g);
          if (i.mods)
            for (let m of i.mods)
              mod.push(m);
        }
        bag.push({
          ["w" + ndx2 + "GenNdx"]: gen.length,
          ["w" + ndx2 + "ModNdx"]: mod.length,
        })
        
        gen = Promise.all(gen.map(g => {
          let {k, v} = keyval(g);
          const op = SF2.Generator.names.indexOf(k);
          if (op < 0)
            throw Error("Invalid generator: " + k);
          if (k === "instrument") {
            return this.instruments().then(inst => ({
              sfGenOper: op,
              genAmount: inst.dict.get(v),
            }));
          } else if (k === "sampleID") {
            return this.samples1().then(smpl => ({
              sfGenOper: op,
              genAmount: smpl.dict.get(v),
            }));
          } else {
            return Promise.resolve({
              sfGenOper: op,
              genAmount: v,
            });
          }
        }));

        return Promise.all([
          Promise.resolve(term),
          Promise.resolve(hdr),
          Promise.resolve(bag),
          Promise.resolve(mod),
          gen,
        ]);
      }).then(([term, hdr, bag, mod, gen]) => {
        gen.push(term[letter + "gen"]);
        mod.push(term[letter + "mod"]);
        return {
          hdr: SF2.RecordLayout[hdrName].write(hdrName, hdr),
          bag: SF2.RecordLayout[letter + "bag"].write(letter + "bag", bag),
          mod: SF2.RecordLayout[letter + "mod"].write(letter + "mod", mod),
          gen: SF2.RecordLayout[letter + "gen"].write(letter + "gen", gen),
          dict: dict,
        };
      });
  }

  samples1() {
    return this._smpls || (this._smpls = this.samples2());
  }

  samples2() {
    const dict = new Map();
    return this.readYaml("shdr")
      .then(names => Promise.all([
        this.terminators,
        Promise.all(names.map((name, i) => {
          dict.set(name, i);
          return this.sample(name);
        })),
        this.riff_sdta(),
      ])).then(([term, lst]) => {
        lst = lst.map(s => Object.assign({}, s, {
          dwStart: s.pos,
          dwEnd: s.pos + s.dwEnd,
          dwStartloop: s.pos + s.dwStartloop,
          dwEndloop: s.pos + s.dwEndloop,
          wSampleLink: typeof s.wSampleLink === "string" ?
            dict.get(s.wSampleLink) : s.wSampleLink,
        })).concat(term.shdr);
        return {
          shdr: SF2.RecordLayout.shdr.write("shdr", lst),
          dict: dict,
        };
      });
  }

}

function writeFile(name, data) {
  return new Promise((resolve, reject) => fs.writeFile(
    name, data, err => err ? reject(err) : resolve()));
}

if (require.main === module) {
  let status = 2;
  process.on("beforeExit", () => process.exit(status));
  (new YamlParse(process.argv[2])).compile()
    .then(sf2 => writeFile(process.argv[3] || "out.sf2", sf2))
    .then(() => status = 0, (err) => { console.error(err); status = 1; });
}

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SF2 = require("./SF2");

const presetKeys = SF2.RecordLayout.phdr.names.concat(
  "global", "zones", "gens", "mods"
);

const instrumentKeys = SF2.RecordLayout.inst.names.concat(
  "global", "zones", "gens", "mods"
);

const sampleKeys = SF2.RecordLayout.shdr.names.concat(
  "sdta", "length", "smpl", "sm24"
);

const termKeys = ["phdr", "inst", "shdr"].concat(
  SF2.RecordLayout.phdr.names,
  SF2.RecordLayout.inst.names,
  SF2.RecordLayout.shdr.names
);

class YamlGen {

  constructor(sf2, dir="out/", verify=false) {
    this.sf2 = sf2;
    this.dir = dir;
    this.verify = verify ? {} : null;
    this.writing = 0;
    this.writeQueue = [];

    const dirs = [
      dir,
      dir + "presets",
      dir + "instruments",
      dir + "samples",
      dir + "wav",
    ];
    for (let dir of dirs) {
      try {
        fs.mkdirSync(dir);
      } catch (e) {
        if (e.code !== "EEXIST")
          throw e;
      }
    }

    this.presets = this.safeNames(this.sf2.phdr.map(i => i.achPresetName));
    this.instruments = this.safeNames(this.sf2.inst.map(i => i.achInstName));
    this.samples = this.safeNames(this.sf2.shdr.map(i => i.achSampleName));
    this.writeYaml("RIFF", this.riff(this.sf2)[""]);
    this.writeYaml("INFO", this.info());
    this.writeYaml("sdta", this.sdta());
    this.writeYaml("phdr", this.presets);
    this.writeYaml("inst", this.instruments);
    this.writeYaml("shdr", this.samples);
    this.writeYaml("term", this.terminators(), termKeys);
    for (let i of this.sf2.phdr)
      this.writeYaml(
        "presets/" + this.presets[i.id],
        this.preset(i),
        presetKeys);
    for (let i of this.sf2.inst)
      this.writeYaml(
        "instruments/" + this.instruments[i.id],
        this.instrument(i),
        instrumentKeys);
  }

  safeName(str) {
    return str
      .replace(/\0[^]*/, "")
      .replace(/[^a-zA-Z0-9_\-]+/g, "_")
      .replace(/^_/, "").replace(/_$/, "");
  }

  safeNames(names) {
    const res = names.map(this.safeName, this);
    // TODO: detect and handle case-insensitive duplicates
    return res;
  }

  writeFile(file, buf) {
    if (this.verify)
      this.verify[file] = buf;
    if (this.writing >= 12) {
      this.writeQueue.push({file, buf});
      return;
    }
    this.writing++;
    fs.writeFile(this.dir + file, buf, err => {
      if (err) throw err;
      this.writing--;
      if (this.writing < 12 && this.writeQueue.length) {
        const q = this.writeQueue.shift();
        this.writeFile(q.file, q.buf);
      }
    });
  }
    
  writeYaml(name, content, names) {
    let sortKeys = true;
    if (names)
      sortKeys = ((a, b) => names.indexOf(a) - names.indexOf(b));
    const yml = yaml.safeDump(content, { sortKeys: sortKeys })
          .replace(/[^\n\x20-\x7e]/g, c => {
            c = c.charCodeAt(0).toString(16);
            if (c.length <= 2)
              c = "\\x" + "0".repeat(2 - c.length) + c;
            else
              c = "\\u" + "0".repeat(4 - c.length) + c;
            return c;
          });
    this.writeFile(name + ".yml", yml);
  }

  info() {
    const info = this.sf2.chunks[0].firstForName("INFO");
    const res = {};
    for (let c of info.chunks) {
      if (c.id === "ifil" && c.data.length === 4) {
        res.ifil = {
          wMajor: c.data.readUInt16LE(0),
          wMinor: c.data.readUInt16LE(2),
        }
        continue;
      }
      if ((c.data.length & 1) === 0) {
        let str = c.data.toString("ascii");
        if (Buffer.from(str, "ascii").equals(c.data) && /\0$/.test(str)) {
          res[c.id] = str.replace(/\0?\0$/, "");
          continue;
        }
      }
      res[c.id] = {hex: c.data.toString("hex")};
    }
    return res;
  }

  terminators() {
    let term, rec;
    let res = {};

    term = Object.assign({}, this.sf2.phdr.sf2Terminator);
    delete term.id;
    delete term.wPresetBagNdx;
    res.phdr = term;

    res.inst = {
      achInstName: this.sf2.inst.sf2Terminator.achInstName
    };

    term = Object.assign({}, this.sf2.shdr.sf2Terminator);
    delete term.id;
    res.shdr = term;

    return res;
  }

  sdta() {
    const sdta = this.sf2.chunks[0].firstForName("sdta");
    const smpl = sdta.firstForName("smpl");
    const sm24 = sdta.firstForName("sm24");
    this.sdtaMap = new Map();
    let seq = [];
    for (let s of this.sf2.shdr) {
      if (this.sdtaMap.has(s.dwStart)) continue;
      let link = {
        name: this.samples[s.id],
        start: s.dwStart,
        end: s.dwEnd,
        rate: s.dwSamplerRate,
        shdr: s,
      };
      this.sdtaMap.set(link.start, link);
      seq.push(link);
    }
    seq.sort((a, b) => a.start - b.start);
    if (seq[0].start !== 0) {
      seq.unshift({
        name: "_",
        start: 0,
        end: seq[0].start,
        rate: 44100,
      });
    }
    seq.push({
      name: "_END_",
      start: smpl.data.length / 2,
      end: smpl.data.length / 2,
      rate: 44100,
    });
    for (let i = 1; i < seq.length; ++i) {
      const a = seq[i - 1], b = seq[i];
      a.next = b;
      if (a.end > b.start) a.end = b.start;
      for (let j = a.end; j < b.start; ++j) {
        if (smpl.data.readUInt16LE(j << 1) ||
            (sm24 && sm24.data.readUInt8(j))) {
          // non-zero data in gap between samples
          let link = {
            name: a.name + "_",
            start: a.end,
            end: b.start,
            rate: a.rate,
            next: b,
          };
          a.next = link;
          seq.splice(i, 0, link);
          break;
        }
      }
    }
    seq.pop();
    const res = [];
    for (let s of seq) {
      let hi = smpl.data.slice(s.start << 1, s.end << 1), lo = null;
      let h = crypto.createHash("sha1");
      h.update(hi);
      let d = {
        length: s.end - s.start,
        smpl: h.digest("hex"),
      };
      if (sm24) {
        lo = sm24.data.slice(s.start, s.end);
        h = crypto.createHash("sha1");
        h.update(lo);
        d.sm24 = h.digest("hex");
      }
      this.writeWav(s.name, s.rate, hi, lo);
      var shdr = s.shdr ? this.sample(s.shdr) : {};
      shdr.sdta = d;
      this.writeYaml("samples/" + s.name, shdr, sampleKeys);
      res.push(s.name);
      if (s.next.start - s.end !== 32)
        res.push({gap: s.next.start - s.end});
    }
    return res;
  }

  writeWav(name, rate, hi, lo) {
    const channels = 1;
    const bytesPerSample = lo === null ? 2 : 3;
    const headlen = 16;
    const datalen = lo ? hi.length + lo.length : hi.length;
    const buf = Buffer.alloc(headlen + datalen + 2*8 + 12);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(headlen + datalen + 2*8 + 4, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(headlen, 16);
    let pos = 20;
    const blockAlign = channels * bytesPerSample;
    buf.writeUInt16LE(1, pos); // formatTag: PCM
    buf.writeUInt16LE(channels, pos + 2);
    buf.writeUInt32LE(rate, pos + 4);
    buf.writeUInt32LE(rate * blockAlign, pos + 8);
    buf.writeUInt16LE(blockAlign, pos + 12);
    buf.writeUInt16LE(bytesPerSample * 8, pos + 14);
    pos += 16;
    buf.write("data", pos);
    buf.writeUInt32LE(datalen, pos + 4);
    pos += 8;
    if (!lo) {
      hi.copy(buf, pos);
    } else {
      for (let i = 0; i < lo.length; ++i) {
        buf.writeUInt8(lo.readUInt8(i));
        buf.writeInt16LE(hi.readInt16LE(i << 1));
      }
    }
    this.writeFile("wav/" + name + ".wav", buf);
  }

  riff(chunk) {
    if (chunk.chunks)
      return {[chunk.id]: chunk.chunks.map(this.riff, this)};
    return chunk.id;
  }

  preset(p) {
    const res = {};
    for (let k of SF2.RecordLayout.phdr.names)
      if (k !== "wPresetBagNdx")
        res[k] = p[k];
    res.zones = p.zones.map(z => {
      const r = {};
      if (z.gens.length)
        r.gens = z.gens.map(g => {
          let v = g.value;
          if (v instanceof SF2.Range)
            v = String(v);
          if (g.name === "instrument")
            v = this.instruments[v];
          return {[g.name]: v};
        });
      if (z.mods.length)
        r.mods = z.mods;
      return r;
    });
    if (res.zones.length &&
        res.zones[0].gens.length &&
        !res.zones[0].gens[res.zones[0].gens.length - 1].instrument)
      res.global = res.zones.shift();
    return res;
  }

  instrument(i) {
    const res = {};
    for (let k of SF2.RecordLayout.inst.names)
      if (k !== "wInstBagNdx")
        res[k] = i[k];
    res.zones = i.zones.map(z => {
      const r = {};
      if (z.gens.length)
        r.gens = z.gens.map(g => {
          let v = g.value;
          if (v instanceof SF2.Range)
            v = String(v);
          if (g.name === "sampleID")
            v = this.samples[v];
          return {[g.name]: v};
        });
      if (z.mods.length)
        r.mods = z.mods;
      return r;
    });
    if (false && res.zones.length &&
        res.zones[0].gens.length &&
        !res.zones[0].gens[res.zones[0].gens.length - 1].sampleID)
      res.global = res.zones.shift();
    return res;
  }

  sample(s) {
    const res = {};
    for (let k of SF2.RecordLayout.shdr.names)
      if (k !== "dwStart")
        res[k] = s[k];
    res.dwEnd -= s.dwStart;
    res.dwStartloop -= s.dwStart;
    res.dwEndloop -= s.dwStart;
    if (this.sf2.shdr[s.wSampleLink].wSampleLink === s.id) // paired
      res.wSampleLink = this.samples[res.wSampleLink];
    return res;
  }

}

fs.readFile(process.argv[2], function(err, buf) {
  if (err) throw err;
  let sf2 = new SF2.SF2(buf);
  new YamlGen(sf2, process.argv[3] || "out/");
});

class Chunk {

  constructor(id, data) {
    this.id = id;
    this.data = data;
  }

  zstr(enc) {
    let buf = this.data;
    let pos = buf.indexOf(0);
    if (pos !== -1) buf = buf.slice(0, pos);
    return buf.toString(enc);
  }

  toString() {
    return this.id + "[" + this.data.length + "]";
  }

}


class RIFF {

  constructor(buf, id="") {
    this.id = id;
    this.data = buf;
    let chunks = this.chunks = [];
    let pos = 0;
    while (pos < buf.length) {
      if (pos + 8 > buf.length)
        throw Error("Incomplete chunk header");
      let id = buf.toString("ascii", pos, pos + 4);
      let len = buf.readUInt32LE(pos + 4);
      if (pos + 8 + len > buf.length) {
        let idBytes = buf.slice(pos, pos + 4);
        if (Buffer.from(id, "ascii").equals(idBytes))
          throw Error("Incomplete chunk body for id '" + id + "'");
        throw Error("Incomplete chunk body for id " + idBytes.toString("hex"));
      }
      id = id.replace(/ +$/, "");
      let data = buf.slice(pos + 8, pos + 8 + len);
      let res = undefined;
      let handler = this["chunk_" + id];
      if (handler) res = handler.call(this, data);
      if (res === undefined) res = new Chunk(id, data);
      chunks.push(res);
      pos += 8 + len + (len & 1);
    }
  }

  chunk_RIFF(data) {
    if (data.length < 4)
      throw Error("Missing type name");
    let type = data.toString("ascii", 0, 4).replace(/ +$/, "");
    return new RIFF(data.slice(4), type);
  }

  chunk_LIST(data) {
    let res = this.chunk_RIFF(data);
    res.isList = true;
    return res;
  }

  _str(head, body) {
    if (this.isList)
      return head + "(" + body + ")";
    else if (this.id === "")
      return "RIFF[" + body + "]";
    else
      return head + "{" + body + "}";
  }

  toString() {
    return this._str(this.id, this.chunks.join(", "));
  }

  firstForName(name) {
    for (let chunk of this.chunks) {
      if (chunk !== null && chunk.id === name)
        return chunk;
    }
    return null;
  }

  get info() {
    const info = this.chunks[0].firstForName("INFO");
    if (!info) return null;
    let res = {};
    for (let c of info.chunks) {
      if (c.zstr) res[c.id] = c.zstr();
    }
    return res;
  }

}


// http://www.synthfont.com/sfspec24.pdf

class RecordLayout {

  constructor(layout, checkLength) {
    let parts = this.parts = [];
    this.len = 0;
    for (let part of layout) {
      let [type, name] = part.split(" ");
      let len = +type.slice(1);
      this.len += len;
      if (typeof this[type] !== "function")
        throw Error("Invalid type: " + type);
      parts.push({name, len, dec: this[type]});
    }
    if (checkLength !== undefined && this.len !== checkLength)
      throw Error("RecordLayout length mismatch");
  }

  get names() {
    return this.parts.map(p => p.name);
  }

  parse(chunk) {
    let data = chunk.data;
    if (data.length % this.len || data.length === 0)
      throw Error("Malformed " + chunk.id + " chunk");
    let res = [];
    let pos = 0;
    let id = 0;
    while (pos < data.length) {
      let rec = {id: id++};
      for (let part of this.parts) {
        rec[part.name] = part.dec(data, pos);
        pos += part.len;
      }
      res.push(rec);
    }
    return res;
  }

  u1(buf, pos) {
    return buf.readUInt8(pos);
  }

  i1(buf, pos) {
    return buf.readInt8(pos);
  }

  z20(buf, pos) {
    return buf.toString("binary", pos, pos + 20).replace(/\0+$/, "");
  }

  u2(buf, pos) {
    return buf.readUInt16LE(pos);
  }

  i2(buf, pos) {
    return buf.readInt16LE(pos);
  }

  u4(buf, pos) {
    return buf.readUInt32LE(pos);
  }

  a2(buf, pos) {
    return {
      ranges: new Range(buf.readInt8(pos), buf.readInt8(pos + 1)),
      shAmount: buf.readInt16LE(pos),
      wAmount: buf.readUInt16LE(pos),
    };
  }

}

RecordLayout.phdr = new RecordLayout([
  "z20 achPresetName",
  "u2 wPreset",
  "u2 wBank",
  "u2 wPresetBagNdx",
  "u4 dwLibrary",
  "u4 dwGenre",
  "u4 dwMorphology",
], 38);

RecordLayout.pbag = new RecordLayout([
  "u2 wGenNdx",
  "u2 wModNdx",
], 4);

RecordLayout.pmod = new RecordLayout([
  "u2 sfModSrcOper",
  "u2 sfModDestOper",
  "i2 modAmount",
  "u2 sfModAmtSrcOper",
  "u2 sfModTransOper",
], 10);

RecordLayout.pgen = new RecordLayout([
  "u2 sfGenOper",
  "a2 genAmount",
], 4);

RecordLayout.inst = new RecordLayout([
  "z20 achInstName",
  "u2 wInstBagNdx",
], 22);

RecordLayout.ibag = new RecordLayout([
  "u2 wInstGenNdx",
  "u2 wInstModNdx",
], 4);

RecordLayout.imod = RecordLayout.pmod;

RecordLayout.igen = RecordLayout.pgen;

RecordLayout.shdr = new RecordLayout([
  "z20 achSampleName",
  "u4 dwStart",
  "u4 dwEnd",
  "u4 dwStartloop",
  "u4 dwEndloop",
  "u4 dwSamplerRate",
  "u1 byOriginalPitch",
  "i1 chPitchCorrection",
  "u2 wSampleLink",
  "u2 sfSampleType",
], 46);


class Range {

  constructor(lo, hi) {
    this.byLo = lo;
    this.byHi = hi;
  }

  toString() {
    return `${this.byLo}-${this.byHi}`;
  }

}


class Generator {

  constructor(data) {
    this.sfGenOper = data.sfGenOper;
    this.genAmount = data.genAmount;
  }

  get name() {
    return Generator.names[this.sfGenOper] || String(this.sfGenOper);
  }

  get kind() {
    switch (this.sfGenOper) {
      case 41: // instrument
      case 53: // sampleID
        return "index";
      case 43: // keyRange
      case 44: // velRange
        return "range";
      case 46: // keynum
      case 47: // velocity
        return "substitution";
      case 0: // startAddrsOffset
      case 1: // endAddrsOffset
      case 2: // startloopAddrsOffset
      case 3: // endloopAddrsOffset
      case 4: // startAddrsCoarseOffset
      case 12: // endAddrsCoarseOffset
      case 45: // startloopAddrsCoarseOffset
      case 50: // endloopAddrsCoarseOffset
      case 54: // sampleModes
      case 58: // overridingRootKey
      case 57: // exclusiveClass
        return "sample";
      default:
        return "value";
    }
  }

  get value() {
    switch (this.kind) {
      case "range":
        return this.genAmount.ranges;
      case "index":
        return this.genAmount.wAmount;
      default:
        return this.genAmount.shAmount;
    }
  }

  toString() {
    return `${this.name}(${this.value})`;
  }

  static build(records) {
    const res = records.map(g => new Generator(g));
    res.sf2Terminator = records.sf2Terminator;
    return res;
  }

}

Generator.names = [
  /*  0: */ "startAddrsOffset",
  /*  1: */ "endAddrsOffset",
  /*  2: */ "startloopAddrsOffset",
  /*  3: */ "endloopAddrsOffset",
  /*  4: */ "startAddrsCoarseOffset",
  /*  5: */ "modLfoToPitch",
  /*  6: */ "vibLfoToPitch",
  /*  7: */ "modEnvToPitch",
  /*  8: */ "initialFilterFc",
  /*  9: */ "initialFilterQ",
  /* 10: */ "modLfoToFilterFc",
  /* 11: */ "modEnvToFilterFc",
  /* 12: */ "endAddrsCoarseOffset",
  /* 13: */ "modLfoToVolume",
  /* 14: */ "unused1",
  /* 15: */ "chorusEffectsSend",
  /* 16: */ "reverbEffectsSend",
  /* 17: */ "pan",
  /* 18: */ "unused2",
  /* 19: */ "unused3",
  /* 20: */ "unused4",
  /* 21: */ "delayModLFO",
  /* 22: */ "freqModLFO",
  /* 23: */ "delayVibLFO",
  /* 24: */ "freqVibLFO",
  /* 25: */ "delayModEnv",
  /* 26: */ "attackModEnv",
  /* 27: */ "holdModEnv",
  /* 28: */ "decayModEnv",
  /* 29: */ "sustainModEnv",
  /* 30: */ "releaseModEnv",
  /* 31: */ "keynumToModEnvHold",
  /* 32: */ "keynumToModEnvDecay",
  /* 33: */ "delayVolEnv",
  /* 34: */ "attackVolEnv",
  /* 35: */ "holdVolEnv",
  /* 36: */ "decayVolEnv",
  /* 37: */ "sustainVolEnv",
  /* 38: */ "releaseVolEnv",
  /* 39: */ "keynumToVolEnvHold",
  /* 40: */ "keynumToVolEnvDecay",
  /* 41: */ "instrument",
  /* 42: */ "reserved1",
  /* 43: */ "keyRange",
  /* 44: */ "velRange",
  /* 45: */ "startloopAddrsCoarseOffset",
  /* 46: */ "keynum",
  /* 47: */ "velocity",
  /* 48: */ "initialAttenuation",
  /* 49: */ "reserved2",
  /* 50: */ "endloopAddrsCoarseOffset",
  /* 51: */ "coarseTune",
  /* 52: */ "fineTune",
  /* 53: */ "sampleID",
  /* 54: */ "sampleModes",
  /* 55: */ "reserved3",
  /* 56: */ "scaleTuning",
  /* 57: */ "exclusiveClass",
  /* 58: */ "overridingRootKey",
  /* 59: */ "unused5",
  /* 60: */ "endOper",
];
if (Generator.names.length !== 61)
  throw Error("Error in generator names table");


class SF2 extends RIFF {

  get pdta() {
    if (this._pdta) return this._pdta;
    return this._pdta = this.chunks[0].firstForName("pdta");
  }

  _cachedRecord(name, pairwise, postproc) {
    let _name = "_" + name;
    if (this[_name]) return this[_name];
    let res = RecordLayout[name].parse(this.pdta.firstForName(name));
    if (pairwise) {
      if (typeof pairwise === "function")
        for (let i = 1; i < res.length; ++i)
          pairwise(res[i - 1], res[i]);
      res.sf2Terminator = res.pop();
    }
    if (postproc) res = postproc(res);
    return this[_name] = res;
  }

  get shdr() {
    return this._cachedRecord("shdr", true);
  }

  get pmod() {
    return this._cachedRecord("pmod");
  }

  get pgen() {
    return this._cachedRecord("pgen", null, Generator.build);
  }

  get pbag() {
    if (this._pbag) return this._pbag;
    const pgen = this.pgen;
    const pmod = this.pmod;
    return this._cachedRecord("pbag", (cur, next) => {
      cur.gens = pgen.slice(cur.wGenNdx, next.wGenNdx);
      cur.mods = pmod.slice(cur.wModNdx, next.wModNdx);
    });
  }

  get phdr() {
    if (this._phdr) return this._phdr;
    const pbag = this.pbag;
    return this._cachedRecord("phdr", (cur, next) => {
      cur.zones = pbag.slice(cur.wPresetBagNdx, next.wPresetBagNdx);
      cur.localZones = this._localZones(cur.zones, "instrument", this.inst);
      let insts = new Set(cur.localZones.map(z => z.instrument.id));
      insts = Array.from(insts.values()).sort((a, b) => a - b);
      cur.instruments = insts.map(i => this.inst[i]);
    });
    return res;
  }

  get imod() {
    return this._cachedRecord("imod");
  }

  get igen() {
    return this._cachedRecord("igen", null, Generator.build);
  }

  get ibag() {
    if (this._ibag) return this._ibag;
    const igen = this.igen;
    const imod = this.imod;
    return this._cachedRecord("ibag", (cur, next) => {
      cur.gens = igen.slice(cur.wInstGenNdx, next.wInstGenNdx);
      cur.mods = imod.slice(cur.wInstModNdx, next.wInstModNdx);
    });
  }

  get inst() {
    if (this._inst) return this._inst;
    const ibag = this.ibag;
    return this._cachedRecord("inst", (cur, next) => {
      cur.zones = ibag.slice(cur.wInstBagNdx, next.wInstBagNdx);
      cur.localZones = this._localZones(cur.zones, "sampleID", this.shdr);
    });
  }

  _localZones(zones, local, link) {
    if (!zones.length) return [];
    zones = zones.map(z => {
      let res = {gens: z.gens};
      if (z.mods) res.mods = z.mods;
      for (let g of z.gens)
        res[g.name] = g.value;
      return res;
    });
    if (!zones[0].hasOwnProperty(local)) {
      let global = zones.shift();
      for (let z of zones)
        for (let name in global)
          if (!z.hasOwnProperty(name))
            z[name] = global[name];
    }
    for (let z of zones) {
      let id = z[local];
      if (id === undefined)
        throw Error("Unexpected global zone");
      let dst = link[id];
      if (!dst)
        throw Error(`Failed to link ${local} ${id}`);
      z[local] = dst;
    }
    return zones;
  }

}


module.exports.Chunk = Chunk;
module.exports.RIFF = RIFF;
module.exports.Range = Range;
module.exports.RecordLayout = RecordLayout;
module.exports.SF2 = SF2;

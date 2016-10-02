# The YAML representation of a soundfont

The [YAML][YAML] representation of a soundfont is a textual representation
of the content of an SoundFont bank.
It closely follows the structure of SF2 files,
so the [SoundFont Technical Specification][SF2] will be relevant
to understanding the content of these files.
This document here assumes the reader is familiar with that specification.

The chosen format allows a byte-exact reproduction of a given soundfont file.
Due to this goal, some of the information contained in the representation
is irrelevant for the behavior of the generated soundfont,
but will affect the binary representation of that soundfont.

## Info

The file `INFO.yml` contains an object which represents global file metadata:

* `ifil`: version of the SoundFont specification.
  This is the only non-string value of this object.
  Instead it is an object of the form `{wMajor:‹int›, wMinor:‹int›}`
  describing the version number as two integer components.
* `INAM`: name of the bank.
* `ICRD`: creation date, conventionally as “‹month› ‹day›, ‹year›”.
* `IENG`: name of the designer and / or engineer.
* `IPRD`: intended product.
* `ICOP`: copyright statement.
* `ICMT`: comment.
* `ISFT`: used editors, namely the tool used for the initial creation
  and the tool used for the most recent modification, separated by a colon.

ROM-based samples are not supported yet.

## Presets

The file `phdr.yml` contains an array of strings.
Each string is the base name of a file.
The file name is actually irrelevant when creating the binary representation,
so it is possible to rename the files as long as the entries in this list
are changed accordingly.
The order of string is only relevant for binary reproducibility.

For each name from this list, `presets/‹name›.yml` contains
details about this preset, corresponding to the
`PHDR`, `PBAG`, `PMOD` and `PGEN` chunks of the SF2 file.

* `achPresetName`: name of the preset (up to 20 characters)
* `wPreset`: MIDI preset number
* `wBank`: MIDI bank number
* `dwLibrary`, `dwGenre` and `dwMorphology`: reserved for future use
* `global`: object describing the global zone, see below
* `zones`: array of objects, each describing one zone, see below

## Instruments

The file `inst.yml` contains an array of strings.
Each string is the base name of a file,
similar to the way presets are identified (see there for details).
For each name from this list, `instruments/‹name›.yml` contains
details about the instrument, corresponding to the
`INST`, `IBAG`, `IMOD` and `IGEN` chunks of the SF2 file.

* `achInstName`: name of the instrument (up to 20 characters)
* `global`: object describing the global zone, see below
* `zones`: array of objects, each describing one zone, see below

## Zone description

A zone (i.e. either the `global` zone or one item from the `zones` array)
is represented by an object which contains two properties,
namely `gens` for a list of generators and `mods` for a list of modifiers.
Both of these are optional.

The generators are given as an array of one-element objects,
with the generator name as key and the corresponding amount as value.
The order of these items should be irrelevant for the interpretation of the
soundfont, but it is required for byte-exact reproduction of the binary form.
Values are represented as integer numbers, except for range-values generators,
which are represented as a string of the form `‹low›-‹high›`.

The generators `instrument` or `sampleID` are represented as strings,
with the string value corresponding to the base name of the corresponding
instrument or sample file name.

The modifiers are represented asn array of objects,
each of which has the keys `sfModSrcOper`, `sfModDestOper`,
`modAmount`, `sfModAmtSrcOper` and `sfModTransOper`
as described in the SF2 format specification.
Currently all of these are given as integers,
although a future version of this format may provide more human-readable
string representations for some of these.

## Samples

The files `sdta.yml` and `shdr.yml` both contain an array of strings,
each of them giving the base name of a file.
These two files can have exactly the same content.
The distinction is relevant only for binary exactness,
since `sdta.yml` gives the order of raw sample data in the `sdta` chunk
while `shdr.yml` gives the order of sample metadata in the `shdr` chunk.

In addition to sample file names, the `sdta.yml` array may also contain
objects with `gap` as the sole property and an integer value for it.
These change the gap between samples from the default
of 32 zero sample data points to the number of sample data points
idicated by the given value.
This change affects the gap where this object was first mentioned
and any subsequent gaps between adjacent samples or past the last sample.
It is an error to give a gap object before the first sample,
or more than one gap description between actual sample names.

For each sample base name, `wav/‹name›.wav` will contain the
PCM audio data of the sample, encoded as a WAVE file,
corresponding to the `sdta` chunk of the SF2 file.
Some projects may choose to store these in a different representation,
e.g. as FLAC-encoded files `flac/‹name›.flac`.
Furthermore, `samples/‹name›.yml` contains metadata about the sample,
mostly corresponding to the `shdr` chunk of the SF2 file.

* `achSampleName`: name of the sample (up to 20 characters)
* `dwEnd`: end of the sample, relative to its start, in sample data points
* `dwStartloop`: start of the loop, relative to start of the sample
* `dwEndloop`: end of the loop, relative to start of the sample
* `dwSampleRate`: sample rate in Hz
* `byOriginalPitch`: recorded pitch, as MIDI key number
* `chPitchCorrection`: amount of correction to apply, in cents
* `wSampleLink`: base name of the corresponding opposite channel or `0`
* `sfSampleType`: integer, `1` for mono, `2` for right or `4` for left channel
* `sdta`: object containing these properties:
  * `length`: length of the sample, in sample data points
  * `smpl`: SHA1 checksum of the `smpl` data of this sample
  * `sm24`: SHA1 checksum of the `sm24` data of this sample (24bit samples only)

The presence of the checksums helps ensuring lossless handling of sample data.
It can also be used to easily detect when the raw data of a sample changed,
as opposed to merely technical file differences due to different encoding,
different compression or different metadata in the WAVE file.

## File structure

Two more files are mostly irrelevant for the behavior of the soundfont,
but relevant for an exact binary reproduction of the soundfont file.

* `RIFF.yml` describes the order of chunks in the RIFF file structure.
* `term.yml` contains the content of terminal records of some data structures.

## Character encodings

The SoundFont specification does not specify an encoding to be used for strings.
For this reason, most strings
(i.e. names `INFO` metadata, and the names of presets, instruments or samples)
should be ASCII only, to maximize interoperability.
Non-ASCII data should be represented by explicitely giving
a binary representation, i.e. only unicode codepoints U+0000 through U+00FF.
A future version of this format specification may offer support for
specification of an encoding along with the value of a string.

[SF2]: http://www.synthfont.com/sfspec24.pdf "SoundFont® Technical Specification 2.04"
[YAML]: http://www.yaml.org/

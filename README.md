# SoundFont Utils

This is a JavaScript library of tools designed to work with sound fonts.

## Conversion between SF2 and YAML

At the moment the main component here is a pair of tools,
designed to run under Node.js, which convert a [SF2 sound font][SF2]
into a set of [YAML][YAML] files
plus some WAV files for the actual sample content.
This can be used to enable collaborative editing of soundfonts
using typical version control systems
and software development workflows aimed at working with source code.

See [the YAML representation of a soundfont][yspec] for details
about the file format.

[SF2]: http://www.synthfont.com/sfspec24.pdf "SoundFont Technical Specification 2.04"
[YAML]: http://www.yaml.org/
[yspec]: https://github.com/gagern/soundfontutils/blob/master/YamlFormat.md

# The translator tools

`tools/translations.py` moves a game's text out to translators and their
work back in, as PO files (gettext), the format Poedit, Weblate, Crowdin
and every other translation tool read (docs/plan.md Phase 54, item 8).
The language files it writes are those of docs/content-format.md,
"Translations". CREATE.md, "Translating a game", walks an author and a
contributor through it; this page is the reference.

```sh
.venv/bin/python tools/translations.py export GAME_FOLDER TAG [--out FILE] [--force]
.venv/bin/python tools/translations.py import GAME_FOLDER FILE.po [--force]
.venv/bin/python tools/translations.py status GAME_FOLDER
```

Exit status: 0 on success, 1 on a refusal or an error, 2 on bad
arguments. `--version` prints `Kinetic <VERSION>`.

## export

Writes one language's PO file, TAG a language tag in canonical case
(`de`, `ja`, `zh-Hans`, `pt-BR`, `es-419`). A malformed tag, one in the
wrong case (`pt-br`) and the game's own language (the manifest's
`language`) are refused. The file goes to `./<storyId>.<TAG>.po` in the
current directory (the folder's name when the manifest has no
`storyId`), or to `--out FILE`, `-` meaning standard output. An existing
file is never replaced without `--force`, since it may hold translations
not yet imported.

The file holds one entry per string a reader sees, in story order: the
title and version, then the items in order, each speaker's name just
before the first line they speak, and each decision's question and its
route labels just after the item the decision opens on.

| `msgctxt` | The string | Language file |
| --- | --- | --- |
| `title` | the manifest's `title` | `title` |
| `version` | the manifest's `version` | `version` |
| `speaker:NAME` | a speaker, once | `speakers.NAME` |
| `item:ID` | the item's `text` | `items.ID` |
| `prompt:DECISION` | the decision's `prompt` | `decisions.DECISION.prompt` |
| `label:DECISION/ROUTE` | the route's `label` | `decisions.DECISION.routes.ROUTE` |

`msgid` is the manifest's text exactly, line breaks included, and
`msgstr` the translation. Extracted comments (`#.`) give the context: for
an item, its speaker (or narration), its type and whether it is a
thought, the two lines before and after it (`id: text`, cut to 60
characters), the innermost route it sits in, the decision it opens, and
its length in characters; for a question or label, its decision, route
and items, and the limit (shorter than 200 for a question, 120 for a
label); for the title and version, their limits (200 and 40).

The header names the language (`Language`), the game (`X-Kinetic-Story`:
the `storyId`, else the title, else the folder's name), the base language
(`X-Kinetic-Base`), the game's title (`Project-Id-Version`) and the
Kinetic that wrote it (`X-Generator`), with `Content-Type: text/plain;
charset=UTF-8`.

When the game already has the language (`lang/TAG.json`), the export
merges it:

- each translation fills its msgstr; a string it lacks has an empty one;
- a translation whose `from` is not the hash of the text now (stale) is
  marked `#, fuzzy`, for a translator to check and clear;
- a translation of a string the game no longer has is written as an
  obsolete `#~` entry with an empty msgid, so the work is not lost;
  translation tools hide these and import ignores them.

## import

Reads a translated PO file and writes `lang/TAG.json` and its
`lang/TAG.js`, TAG from the `Language` header (gettext's `pt_BR` is read
as `pt-BR`). Refused, writing nothing: a file that is not PO, one with no
`Language` header or a malformed one, one in the game's own language,
and one whose `X-Kinetic-Story` names another game unless `--force`
(a file with no `X-Kinetic-Story` is imported with a note).

Per entry, by `msgctxt`:

- a filled msgstr becomes the translation, recording in `from` the hash
  of the entry's msgid, the text it was translated from. When the msgid
  is the game's text now, the translation is current; when the game's
  text has changed since the export, it is stale and a warning says so;
- a `fuzzy` entry is imported as stale: it keeps the language file's
  old `from` when that is already stale, else records the hash of its
  msgid when that differs from the text now, else records the hash of
  the empty text, which no string has. The validator then lists it as
  stale until a translator clears the flag and the file is imported
  again;
- an empty msgstr leaves the string untranslated (the reader sees the
  original), removing a translation the file had; one of only spaces
  does the same, with a warning;
- a speaker's msgstr becomes the speaker's entry in `speakers` (a name
  translated to itself is fine);
- an unknown `msgctxt`, an entry with none, and a plural entry are
  skipped with a warning; obsolete entries are ignored;
- a `msgctxt` given twice, a question of 200 characters or more, a label
  of 120 or more, a title over 200 or a version over 40 is an error, and
  nothing is written.

The language file's `name`, `keepOriginalVoice` and `voice` lines are
kept, as are its translations of strings the PO file does not mention at
all; its translations of strings the game no longer has are dropped
(the validator would reject them). Its keys keep their order. When the
manifest names its schema copy (`"$schema": "./manifest.schema.json"`),
a language file without a `$schema` gets `"$schema":
"../lang.schema.json"` and `lang.schema.json` is written beside the
manifest (docs/content-format.md, "Translations").

TAG is added to the manifest's `languages` when missing (last, or in
place when the list is sorted), changing nothing else in
`manifest.json`, and `manifest.js` is rewritten from it. Then the
validator's checks for that language run: its problems are printed, its
warnings (missing, stale and long lines) go to standard error, and its
coverage line ends the output. The exit status is 1 only on an error.

Exporting a language and importing the file unchanged rewrites its
language file byte for byte.

## status

Prints, per language in the manifest's `languages`, the validator's
coverage line and the strings missing:

```text
fixtures/lang-demo: base language en, 39 strings to translate
de: 38 of 39 strings (97.4%), 1 stale, 0 unchecked, 1 missing
ja: 39 of 39 strings (100%), 0 stale, 0 unchecked, 0 missing
```

Stale strings were translated from an earlier wording; unchecked ones
have no `from`, so it cannot be told. Exit 1 when the validator finds a
problem in the language files.

## PO files

The tools read and write PO with `converter/kinetic_extract/po.py`
(standard library only): the header entry, `msgctxt`, strings over
several lines, the C escapes, translator, extracted, reference, flag and
previous comments, obsolete entries, UTF-8 with or without a byte order
mark, and CRLF line ends. They write strings wrapped at 79 columns as GNU
gettext does, so `msgcat` leaves an exported file as it is, and read any
wrapping back the same.

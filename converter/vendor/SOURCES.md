# Vendored third-party sources

Third-party code is vendored here (not installed as a dependency) so the
converter runs offline and the exact bytes stay pinned. A "pin" is two
things: the upstream commit SHA recorded below, and the file bytes copied
into this tree.

## unrpyc

`.rpyc` decompiler used to read compiled-only Ren'Py projects (a corpus
game such as `the studio's folder/game-d.app` ships 12 `.rpyc` and no
`.rpy`). docs/stack.md §Converter decisions: vendor it, pin the version,
decompile `*.rpyc` only when no `.rpy` exists.

- Project: UnRPyC (the maintained unrpyc, by CensoredUsername and the
  original `deceleration` authors). This is the repository the tool names
  as its own home (`unrpyc.py` sets `__url__ =
  "https://github.com/CensoredUsername/unrpyc"`), and the copy here is
  UnRPyC `v2.0.3`.
- Source URL: https://github.com/CensoredUsername/unrpyc
- Fetched via: `git clone --depth 1 https://github.com/CensoredUsername/unrpyc.git`
- Commit SHA (pin): `3ae8334ed71a05535927dcc559663d3aca51215b`
- Commit date: 2026-02-23 (`Bump ... Install un.rpyc build requirements
  during testing.`; `__version__ = 'v2.0.3'`)
- Date fetched: 2026-10-31 (UTC)
- License: MIT (see `unrpyc/LICENSE`; copyright "Yuri K. Schlesner,
  CensoredUsername, Jackmcbarn"), kept in-tree verbatim.

Local modifications: **none.** Every vendored file is a byte-for-byte
copy of the upstream file at the pinned SHA (verified with `diff -q`
against a fresh clone; only `__pycache__/*.pyc` bytecode differed, which
is not vendored).

### Files vendored (upstream layout preserved)

The maintained unrpyc is a package, not the old single-file script, so
the whole import closure is copied:

- `unrpyc/unrpyc.py` — public API (`get_ast`, `read_ast_from_file`,
  `Context`, and the CLI `main`).
- `unrpyc/deobfuscate.py` — obfuscated-`.rpyc` fallback (`import`ed by
  `unrpyc.py` at module top, so required to import the package).
- `unrpyc/decompiler/*.py` — the AST-to-`.rpy` decompiler package
  (`__init__`, `astdump`, `atldecompiler`, `magic`, `renpycompat`,
  `sl2decompiler`, `testcasedecompiler`, `translate`, `util`).
- `unrpyc/LICENSE` — MIT license text.

Not vendored (not needed for plain `.rpyc`): `setup.py`, `README.md`,
`.github/`, and the `un.rpyc/corrupy` git submodule (only used for
`un.rpyc` corrupt-pickle obfuscation). `testcases/` is upstream test
data, not shipped here.

### Integration (how the converter uses it)

Imported as a module, not run as a subprocess — the least invasive
choice. `kinetic_extract/rpyc.py` inserts this directory on `sys.path`
relative to the installed package, imports `unrpyc`/`decompiler`, and
calls `unrpyc.get_ast(...)` + `decompiler.pprint(...)` into a
`StringIO` buffer, returning decompiled text in memory. This deliberately
does **not** use `unrpyc.decompile_rpyc`, because that helper writes a
`.rpy` next to the input (which would write into the read-only corpus)
and skips a file whose `.rpy` already exists; the converter needs the
text with no corpus writes and its own stale-twin policy. Decompiled text
is cached under `.tmp/kinetic-decompile/` keyed by `(path, mtime, size)`.

Upstream's `decompiler/renpycompat.py` calls `magic.fake_package("renpy")`
to fabricate the Ren'Py modules the AST unpickler expects, so no Ren'Py
install is required to decompile. Verified against the pinned bytes on
Python 3.12.2 with the repo's `.venv` (real Ren'Py 8.2/8.x `.rpyc`
decompile cleanly). No compatibility shim was needed — no local patches.

"""The `kinetic` command: one entry point for Kinetic's tools, each a
subcommand (docs/plan.md Phase 57).

Usage:

    kinetic <command> [options]
    kinetic --version

Each subcommand is a module in this package with a function
`register(subcommands)`, which adds its parser to the argparse
subparsers object it is given (`subcommands.add_parser(name, ...)`) and
sets the parser's default `run` to a function taking the parsed
arguments and returning the exit code. Adding a subcommand is adding
its module and one line to COMMANDS. A module that wraps an existing
tool with its own `main(argv)` can take the rest of the command line
with `nargs=argparse.REMAINDER` and hand it on.

Exit codes are the subcommand's; argparse's usage errors (an unknown
command, a bad option) exit 2.
"""

from __future__ import annotations

import argparse
import importlib
import sys

from kinetic_extract.version import add_version_option

PROG = "kinetic"

# The subcommands' modules, in the order `kinetic --help` lists them.
COMMANDS = (
    "kinetic_extract.report",
)


def parser() -> argparse.ArgumentParser:
    """The `kinetic` parser, every module in COMMANDS registered."""
    argp = argparse.ArgumentParser(
        prog=PROG,
        description="Kinetic's tools for making and checking game folders.")
    add_version_option(argp)
    subcommands = argp.add_subparsers(dest="command", metavar="COMMAND",
                                      required=True)
    for name in COMMANDS:
        importlib.import_module(name).register(subcommands)
    return argp


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(sys.argv[1:] if argv is None else argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())

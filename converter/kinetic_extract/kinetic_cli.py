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
its module and one line to COMMANDS. An entry `module:function` names
another function of the module to call in place of `register`.

A subcommand that wraps an existing tool with its own `main(argv)`
registers it with `add_tool` instead (tool_commands): `kinetic <name>
ARGS...` then hands ARGS, unparsed, to that function, so the tool's own
options, `--help` and exit codes are the subcommand's (`kinetic validate
DIR` is `tools/validate_content.py DIR`).

Exit codes are the subcommand's; argparse's usage errors (an unknown
command, a bad option) exit 2.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from collections.abc import Callable
from typing import Any

from kinetic_extract.version import add_version_option

PROG = "kinetic"

# The subcommands' modules, in the order `kinetic --help` lists them.
COMMANDS = (
    "kinetic_extract.tool_commands:setup",
    "kinetic_extract.tool_commands:extract",
    "kinetic_extract.tool_commands:media",
    "kinetic_extract.tool_commands:validate",
    "kinetic_extract.tool_commands:assemble",
    "kinetic_extract.tool_commands:upgrade",
    "kinetic_extract.tool_commands:check",
    "kinetic_extract.report",
    "kinetic_extract.routes",
    "kinetic_extract.export",
)

# The default an add_tool parser holds its tool's main under.
TOOL_MAIN = "tool_main"


def add_tool(subcommands: Any, name: str, help_text: str,
             tool_main: Callable[[list[str]], int]) -> None:
    """Add the subcommand `name`, whose arguments all go to
    `tool_main(argv)` unparsed; its return value is the exit code."""
    sub = subcommands.add_parser(name, help=help_text, add_help=False)
    sub.set_defaults(**{TOOL_MAIN: tool_main})


def _build() -> tuple[argparse.ArgumentParser, Any]:
    """The `kinetic` parser and its subparsers object."""
    argp = argparse.ArgumentParser(
        prog=PROG,
        description="Kinetic's tools for making and checking game folders.")
    add_version_option(argp)
    subcommands = argp.add_subparsers(dest="command", metavar="COMMAND",
                                      required=True)
    for entry in COMMANDS:
        module, _, function = entry.partition(":")
        getattr(importlib.import_module(module),
                function or "register")(subcommands)
    return argp, subcommands


def parser() -> argparse.ArgumentParser:
    """The `kinetic` parser, every module in COMMANDS registered."""
    return _build()[0]


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    argp, subcommands = _build()
    sub = subcommands.choices.get(argv[0]) if argv else None
    passthrough = None if sub is None else sub.get_default(TOOL_MAIN)
    if passthrough is not None:
        return passthrough(argv[1:])
    args = argp.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())

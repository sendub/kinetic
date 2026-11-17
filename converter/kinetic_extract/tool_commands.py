"""The `kinetic` subcommands that wrap a tool with its own `main(argv)`
(docs/plan.md Phase 57, item 9): each hands its arguments, unparsed, to
the tool, so its options, `--help` and exit codes are the tool's.

    kinetic setup     tools/setup_media_tools.py (setup_media_tools)
    kinetic extract   kinetic-extract (cli)
    kinetic media     kinetic-media: ship, rebuild, posters (media_cli)
    kinetic validate  tools/validate_content.py (validate_content)
    kinetic assemble  tools/assemble_folder.py (assemble_folder)
    kinetic apps      tools/build_apps.py (apps)
    kinetic upgrade   tools/upgrade_folder.py (upgrade_folder)
    kinetic check     check-game (check)

Each function here registers one of them (kinetic_cli's COMMANDS names
it as `kinetic_extract.tool_commands:<function>`). A tool's module is
imported only when its subcommand runs, so `kinetic --help` and the
other subcommands start without loading the media codecs.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Any

from .kinetic_cli import add_tool


def _tool(module: str, call: Callable[[Any, list[str]], int | None]
          ) -> Callable[[list[str]], int]:
    """A tool main that imports kinetic_extract.<module> and runs
    `call(module, argv)`; None from it is exit code 0."""
    def run(argv: list[str]) -> int:
        code = call(importlib.import_module(f"kinetic_extract.{module}"),
                    argv)
        return 0 if code is None else code
    return run


def setup(subcommands: Any) -> None:
    add_tool(subcommands, "setup",
             "install the pinned ffmpeg/ffprobe and run the media self-test",
             _tool("setup_media_tools",
                   lambda tool, argv: tool.main(argv, prog="kinetic setup")))


def extract(subcommands: Any) -> None:
    # cli.py's usage line names `kinetic-extract`, a command of its own.
    add_tool(subcommands, "extract",
             "convert a Ren'Py project into a game folder (kinetic-extract)",
             _tool("cli", lambda tool, argv: tool.main(argv)))


def media(subcommands: Any) -> None:
    add_tool(subcommands, "media",
             "ship, rebuild or check posters of media, no story parse",
             _tool("media_cli",
                   lambda tool, argv: tool.main(argv, prog="kinetic media")))


def validate(subcommands: Any) -> None:
    add_tool(subcommands, "validate",
             "check a game folder against the content format",
             _tool("validate_content",
                   lambda tool, argv: tool.main(argv,
                                                prog="kinetic validate")))


def assemble(subcommands: Any) -> None:
    add_tool(subcommands, "assemble",
             "make the folder readers get: the player beside the content",
             _tool("assemble_folder",
                   lambda tool, argv: tool.main(["kinetic assemble", *argv])))


def apps(subcommands: Any) -> None:
    add_tool(subcommands, "apps",
             "add the Mac app and the Windows exe to a game folder",
             _tool("apps", lambda tool, argv: tool.main(argv)))


def upgrade(subcommands: Any) -> None:
    add_tool(subcommands, "upgrade",
             "give a game folder this Kinetic's player",
             _tool("upgrade_folder",
                   lambda tool, argv: tool.main(["kinetic upgrade", *argv])))


def check(subcommands: Any) -> None:
    add_tool(subcommands, "check",
             "play a game folder with no window; needs Node and Chrome",
             _tool("check", lambda tool, argv: tool.main(argv)))

# ABOUTME: Loads `agents/benchmark/.env.local` into the process environment at CLI start.
#
# Matt runs the rig from PowerShell, where exporting a file of variables is four lines of
# `Set-Item` before every session. The rig can read the file itself. Variables already set in the
# shell always win: an explicit `$env:TEMPORAL_ADDRESS` for one run is not to be overwritten by a
# file the operator forgot was there.

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["load_env_file", "default_env_file"]

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE_NAME = ".env.local"


def default_env_file() -> Path:
    """The env file the CLIs load: `BENCHMARK_ENV_FILE` if set, else `agents/benchmark/.env.local`.

    The override exists so a run can be told to read a different file, and so a test can point at
    a path that does not exist and get the machine's real keys out of its way.
    """
    from_env = os.environ.get("BENCHMARK_ENV_FILE")
    if from_env is not None:
        return Path(from_env).expanduser()
    return PROJECT_ROOT / ENV_FILE_NAME


def load_env_file(path: Path | None = None, environ: dict[str, str] | None = None) -> list[str]:
    """Set variables from `path` that are not already set, and return the names set.

    A missing file is not an error: the rig runs on a machine where every key is exported in the
    shell just as well as on one where none are. Lines that are blank, commented, or not
    `NAME=value` are skipped, and a `export ` prefix and surrounding quotes are tolerated because
    the same file gets sourced by hand.
    """
    target = environ if environ is not None else os.environ
    file_path = path or default_env_file()
    if not file_path.is_file():
        return []

    loaded: list[str] = []
    for line in file_path.read_text(encoding="utf-8-sig").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if text.startswith("export "):
            text = text[len("export ") :].strip()
        name, separator, value = text.partition("=")
        name = name.strip()
        if not separator or not name or not name.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if target.get(name):
            continue
        target[name] = value
        loaded.append(name)
    return loaded

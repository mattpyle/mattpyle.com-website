# ABOUTME: Tests for the `.env.local` loading every CLI does at start.
#
# The rule the rig depends on: a variable already set in the shell is never overwritten, so an
# override for one run survives a file the operator forgot was there.

from __future__ import annotations

from benchmark.envfile import default_env_file, load_env_file

FILE = """\
# a comment
DEEPSEEK_API_KEY=from-file
export TEMPORAL_ADDRESS="ns.acct.tmprl.cloud:7233"
TEMPORAL_NAMESPACE='ns.acct'
not a variable line
EMPTY=
"""


def _write(tmp_path, text=FILE):
    path = tmp_path / ".env.local"
    path.write_text(text, encoding="utf-8")
    return path


def test_it_sets_variables_that_are_not_set(tmp_path):
    environ: dict[str, str] = {}
    loaded = load_env_file(_write(tmp_path), environ)
    assert environ["DEEPSEEK_API_KEY"] == "from-file"
    assert environ["TEMPORAL_ADDRESS"] == "ns.acct.tmprl.cloud:7233"
    assert environ["TEMPORAL_NAMESPACE"] == "ns.acct"
    assert "DEEPSEEK_API_KEY" in loaded and "not" not in environ


def test_a_variable_already_set_in_the_shell_wins(tmp_path):
    environ = {"TEMPORAL_ADDRESS": "localhost:7233"}
    loaded = load_env_file(_write(tmp_path), environ)
    assert environ["TEMPORAL_ADDRESS"] == "localhost:7233"
    assert "TEMPORAL_ADDRESS" not in loaded


def test_a_missing_file_is_not_an_error(tmp_path):
    environ: dict[str, str] = {}
    assert load_env_file(tmp_path / "nothing-here", environ) == []
    assert environ == {}


def test_the_env_file_override_points_somewhere_else(tmp_path, monkeypatch):
    monkeypatch.setenv("BENCHMARK_ENV_FILE", str(tmp_path / "other.env"))
    assert default_env_file() == tmp_path / "other.env"


def test_a_variable_set_to_empty_counts_as_set(tmp_path):
    """`$env:TEMPORAL_API_KEY = ""` is how a run is sent to the local dev server."""
    environ = {"TEMPORAL_API_KEY": ""}
    loaded = load_env_file(_write(tmp_path, "TEMPORAL_API_KEY=from-file\n"), environ)
    assert environ["TEMPORAL_API_KEY"] == "" and loaded == []


def test_an_unquoted_trailing_comment_is_not_part_of_the_value(tmp_path):
    environ: dict[str, str] = {}
    load_env_file(
        _write(
            tmp_path,
            'A=value # why\nB="quoted # kept"\nC=pass#word\n',
        ),
        environ,
    )
    assert environ == {"A": "value", "B": "quoted # kept", "C": "pass#word"}

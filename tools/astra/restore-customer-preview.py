"""Restore only the existing R18 disposable synthetic customer-preview PG cluster.

This helper never provisions databases or runs migrations. It validates the
repository's fixture identity, then starts pg_ctl only when that exact cluster
is stopped. Its output contains no URLs, role names, passwords, or secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
import time
from urllib.parse import unquote, urlsplit


EXPECTED_BINARY = Path(
    "/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin"
)
EXPECTED_LIBRARY = Path(
    "/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/x86_64-linux-gnu"
)
EXPECTED_CLOCK_LIBRARY = Path(
    "/var/tmp/odd-astra-preview-clock/root/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1"
)
HOST_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


def fail(message: str) -> None:
    raise SystemExit(message)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("The recognized customer-preview fixture metadata is unavailable or invalid.")
    if not isinstance(value, dict):
        fail("The recognized customer-preview fixture metadata is invalid.")
    return value


def host_clock_offset() -> int:
    if not Path(HOST_POWERSHELL).is_file():
        fail("The Windows host clock cannot be queried from WSL; no PostgreSQL process was changed.")
    try:
        raw = subprocess.check_output(
            [HOST_POWERSHELL, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
             "-Command", "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()"],
            text=True, timeout=10, stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        fail("The Windows host clock cannot be queried from WSL; no PostgreSQL process was changed.")
    if not raw.isdigit():
        fail("The Windows host clock returned an invalid timestamp; no PostgreSQL process was changed.")
    offset = round(int(raw) / 1000 - time.time())
    if not -86400 <= offset <= 86400:
        fail("The Windows/WSL clock difference exceeds the one-day fixture bound.")
    return offset


def validate_connection(state: dict, suffix: str) -> None:
    database = state.get("databaseName")
    if not isinstance(database, str) or not re.fullmatch(
        r"odd_astra_qa_r18_customer_preview_[a-f0-9]{8}", database, re.I
    ):
        fail("The existing customer-preview database identity is invalid.")
    if database[-8:].lower() != suffix:
        fail("The existing customer-preview database identity does not match its roles.")
    for field, role_kind in (("connectionString", "app"), ("workerConnectionString", "worker")):
        raw = state.get(field)
        try:
            parsed = urlsplit(raw)
            username = unquote(parsed.username or "")
            password = unquote(parsed.password or "")
            role_port = parsed.port
        except (TypeError, ValueError):
            fail("The existing customer-preview database endpoint is invalid.")
        expected_role = rf"astra_qa_{role_kind}_r18_customer_preview_{suffix}"
        if (parsed.scheme not in ("postgres", "postgresql")
                or parsed.hostname != "127.0.0.1"
                or role_port != state.get("port")
                or parsed.path != "/" + database
                or not password
                or not re.fullmatch(expected_role, username, re.I)):
            fail("The existing customer-preview database endpoint or role identity is invalid.")


def validated_fixture(repo: Path) -> tuple[dict, Path, Path, Path, Path, str]:
    state_file = repo / ".runner/astra-qa/r18-customer-preview/pg.json"
    try:
        canonical_state = state_file.resolve(strict=True)
        qa_root = (repo / ".runner/astra-qa").resolve(strict=True)
        relative = canonical_state.relative_to(qa_root)
    except (OSError, ValueError):
        fail("The recognized repository customer-preview fixture is unavailable.")
    if relative != Path("r18-customer-preview/pg.json"):
        fail("Refusing a customer-preview fixture outside the named repository QA state.")

    state = read_json(canonical_state)
    try:
        fixture = Path(state["clusterFixture"]).resolve(strict=True)
        binary = Path(state["binary"]).resolve(strict=True)
        library = Path(state["libraryPath"]).resolve(strict=True)
    except (KeyError, OSError, TypeError):
        fail("The existing customer-preview PostgreSQL paths are unavailable.")
    expected_fixture = re.fullmatch(r"odd-astra-qa-pg-[a-z0-9]+", fixture.name)
    if (os.getuid() != 0
            or state.get("mode") != "disposable-synthetic-qa"
            or state.get("label") != "r18-customer-preview"
            or state.get("realData") is not False
            or fixture.parent != Path("/var/tmp")
            or not expected_fixture
            or binary != EXPECTED_BINARY
            or library != EXPECTED_LIBRARY
            or not (fixture / "data/PG_VERSION").is_file()
            or (fixture / "data/PG_VERSION").read_text(encoding="ascii").strip() != "16"
            or not (fixture / "socket").is_dir()
            or not isinstance(state.get("port"), int)
            or state["port"] != 51643):
        fail("Refusing an unrecognized customer-preview PostgreSQL fixture.")

    try:
        parent_state = read_json(repo / ".runner/astra-preview/pg.json")
        parent_fixture = Path(parent_state["fixture"]).resolve(strict=True)
    except (KeyError, OSError, TypeError):
        fail("The pinned parent preview clock metadata is unavailable.")
    if (state.get("parentPreviewFixture") != str(parent_fixture)
            or parent_state.get("mode") != "disposable-synthetic-preview"
            or parent_fixture.parent != Path("/var/tmp")
            or not parent_fixture.name.startswith("odd-astra-preview-pg-")
            or Path(parent_state.get("binary", "/invalid")).resolve() != EXPECTED_BINARY):
        fail("The customer-preview fixture is not linked to its recognized parent preview.")

    suffix_match = re.fullmatch(
        r"odd_astra_qa_r18_customer_preview_([a-f0-9]{8})",
        state.get("databaseName", ""), re.I,
    )
    if not suffix_match:
        fail("The existing customer-preview database identity is invalid.")
    suffix = suffix_match.group(1).lower()
    validate_connection(state, suffix)
    migrations = state.get("migrations")
    if not isinstance(migrations, list) or len(migrations) not in (32, 33):
        fail("The existing customer-preview migration manifest is invalid; no migrations were run.")

    return state, fixture, binary, library, parent_fixture, suffix


def pg_prefix(library: Path, offset: int, parent_state: dict) -> list[str]:
    prefix = ["runuser", "-u", "nobody", "--", "env", "LD_LIBRARY_PATH=" + str(library)]
    if offset:
        try:
            clock_library = EXPECTED_CLOCK_LIBRARY.resolve(strict=True)
        except OSError:
            fail("The pinned per-process clock library is unavailable; no system clock was changed.")
        pinned_hash = parent_state.get("previewClockLibrarySha256")
        if (not isinstance(pinned_hash, str)
                or not re.fullmatch(r"[a-f0-9]{64}", pinned_hash, re.I)
                or hashlib.sha256(clock_library.read_bytes()).hexdigest() != pinned_hash.lower()):
            fail("The per-process clock library does not match its pinned preview checksum.")
        prefix += ["LD_PRELOAD=" + str(clock_library), "FAKETIME=" + format(offset, "+d"),
                   "FAKETIME_DONT_FAKE_MONOTONIC=1"]
    return prefix


def fixture_status(prefix: list[str], binary: Path, fixture: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        prefix + [str(binary / "pg_ctl"), "-D", str(fixture / "data"), "status"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )


def port_is_open(port: int) -> bool:
    with socket.socket() as client:
        client.settimeout(0.5)
        return client.connect_ex(("127.0.0.1", port)) == 0


def persist_clock_alignment(state_file: Path, validated_state: dict, offset: int) -> None:
    """Atomically update only clock metadata after pg_ctl has started successfully."""
    metadata_keys = {"previewClockOffsetSeconds", "clockAlignmentMode"}
    current = read_json(state_file)
    if ({key: value for key, value in current.items() if key not in metadata_keys}
            != {key: value for key, value in validated_state.items() if key not in metadata_keys}):
        fail("The validated customer-preview fixture metadata changed during startup; clock metadata was not written.")
    current["previewClockOffsetSeconds"] = offset
    current["clockAlignmentMode"] = "restored-disposable-process-only"
    original_mode = stat.S_IMODE(state_file.stat().st_mode)
    temp_path = None
    try:
        descriptor, temp_name = tempfile.mkstemp(
            prefix=".pg.json.clock-", suffix=".tmp", dir=state_file.parent
        )
        temp_path = Path(temp_name)
        os.chmod(temp_path, original_mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(current, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, state_file)
        temp_path = None
        try:
            directory_fd = os.open(state_file.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    except OSError:
        fail("The fixture started, but its private clock metadata could not be atomically saved.")
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--check-only", action="store_true", help="Validate only; do not start PostgreSQL.")
    parser.add_argument("--keepalive", action="store_true",
                        help="Hold this verified WSL process open after readiness so the fixture's WSL session stays available.")
    args = parser.parse_args()
    repo = Path(args.repo).resolve(strict=True)
    state, fixture, binary, library, _parent_fixture, _suffix = validated_fixture(repo)
    parent_state = read_json(repo / ".runner/astra-preview/pg.json")
    offset = host_clock_offset()
    prefix = pg_prefix(library, offset, parent_state)
    status = fixture_status(prefix, binary, fixture)

    if args.check_only:
        recorded_offset = state.get("previewClockOffsetSeconds")
        clock_aligned = (status.returncode != 0 or
                         isinstance(recorded_offset, int) and abs(recorded_offset - offset) < 3)
        print(json.dumps({"valid": True, "alreadyRunning": status.returncode == 0,
                          "loopbackReady": port_is_open(state["port"]),
                          "clockAligned": clock_aligned,
                          "clockOffsetSeconds": offset, "realData": False,
                          "migrationsRun": False, "systemClockChanged": False}))
        return

    if status.returncode == 0:
        recorded = state.get("previewClockOffsetSeconds")
        if not isinstance(recorded, int) or abs(recorded - offset) >= 3:
            fail("The recognized PostgreSQL fixture is already running with a different recorded clock alignment; it was left untouched.")
        if not port_is_open(state["port"]):
            fail("The recognized PostgreSQL process is running but its loopback endpoint is not ready.")
        already_running = True
    else:
        if port_is_open(state["port"]):
            fail("Loopback port 51643 is occupied by a process that is not proven to be this fixture; it was left untouched.")
        log_path = fixture / "postgres.log"
        start = subprocess.run(
            prefix + [str(binary / "pg_ctl"), "-D", str(fixture / "data"),
                      "-l", str(log_path), "-o", "-k " + str(fixture / "socket")
                      + " -p 51643 -c listen_addresses=127.0.0.1 -c jit=off", "-w", "start"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if start.returncode != 0 or not port_is_open(state["port"]):
            fail("pg_ctl could not restore the recognized customer-preview fixture. Private diagnostics remain in its existing fixture log.")
        persist_clock_alignment(repo / ".runner/astra-qa/r18-customer-preview/pg.json", state, offset)
        already_running = False

    print(json.dumps({"ready": True, "alreadyRunning": already_running,
                      "port": state["port"], "clockOffsetSeconds": offset,
                      "realData": False, "migrationsRun": False,
                      "systemClockChanged": False}), flush=True)
    if args.keepalive:
        while True:
            time.sleep(20)


if __name__ == "__main__":
    main()

"""Run a queued Astra offline evaluation through Inspect AI.

This adapter sends only tenant and run identifiers to the authenticated app
harness. Frozen example packets and labels remain inside the Astra service;
Inspect logs contain only run status and report hashes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def _safe_base_url(value: str) -> str:
    parsed = urlsplit(value)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("ASTRA_EVAL_BASE_URL must use HTTPS or loopback HTTP.")
    if not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("ASTRA_EVAL_BASE_URL must be an origin/path without embedded credentials or query data.")
    return value.rstrip("/")


def _request_json(base_url: str, cookie: str, csrf: str, method: str, path: str) -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "Cookie": cookie,
        "Cache-Control": "no-store",
    }
    body = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        headers["X-CSRF-Token"] = csrf
        body = b"{}"
    request = Request(f"{base_url}{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=15) as response:
            raw = response.read(256 * 1024)
            result = json.loads(raw.decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Astra harness returned HTTP {error.code}.") from None
    except (URLError, TimeoutError, OSError, UnicodeError, json.JSONDecodeError):
        raise RuntimeError("Astra harness request failed; response details were withheld.") from None
    if not isinstance(result, dict):
        raise RuntimeError("Astra harness returned an invalid response.")
    return result


def _build_inspect_task(base_url: str, cookie: str, csrf: str, tenant_id: str, run_id: str, wait_seconds: int) -> Any:
    try:
        from inspect_ai import Task, eval as inspect_eval
        from inspect_ai.dataset import MemoryDataset, Sample
        from inspect_ai.scorer import Score, scorer
        from inspect_ai.solver import solver
    except ModuleNotFoundError as error:
        if error.name and error.name.startswith("inspect_ai"):
            raise RuntimeError(
                "Inspect AI is not installed in this Python environment. Activate the approved Inspect AI runtime; "
                "this adapter does not install packages."
            ) from None
        raise

    route = f"/api/astra/tenants/{tenant_id}/evaluation/runs/{run_id}"

    @solver
    def run_app_harness():
        async def solve(state: Any, _generate: Any) -> Any:
            start = _request_json(base_url, cookie, csrf, "POST", f"{route}/execute")
            if start.get("state") not in {"execution_requested", "completed"}:
                raise RuntimeError("Astra harness did not accept the queued run.")
            deadline = time.monotonic() + wait_seconds
            while time.monotonic() < deadline:
                response = _request_json(base_url, cookie, csrf, "GET", route)
                run = response.get("run")
                if not isinstance(run, dict):
                    raise RuntimeError("Astra harness did not return a run status.")
                status = run.get("state")
                if status in {"completed", "failed"}:
                    state.metadata = {
                        **state.metadata,
                        "astra_status": status,
                        "astra_report_sha256": run.get("reportSha256"),
                        "astra_error_code": run.get("errorCode"),
                    }
                    return state
                if status != "running" and status != "queued":
                    raise RuntimeError("Astra harness returned an unsupported run state.")
                time.sleep(1)
            raise RuntimeError("Astra harness run did not finish within the configured wait limit.")

        return solve

    @scorer
    def app_harness_result():
        async def score(state: Any, _target: Any) -> Any:
            status = state.metadata.get("astra_status")
            if status not in {"completed", "failed"}:
                raise RuntimeError("Astra harness result is missing.")
            return Score(
                value=1 if status == "completed" else 0,
                answer=status,
                explanation="Astra run state only; metric computation and report storage remain in the app harness.",
            )

        return score

    task = Task(
        name="astra_offline_evaluation_adapter",
        model=None,
        dataset=MemoryDataset(
            [
                Sample(
                    input="Execute the queued Astra evaluation run by its opaque identifier.",
                    target="completed",
                    id=run_id,
                    metadata={"tenant_id": tenant_id, "run_id": run_id},
                )
            ]
        ),
        solver=run_app_harness(),
        scorer=app_harness_result(),
    )
    return inspect_eval, task


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True, help="Astra tenant UUID")
    parser.add_argument("--run-id", required=True, help="Previously queued Astra evaluation run UUID")
    parser.add_argument("--wait-seconds", type=int, default=120)
    parser.add_argument("--log-dir", default=None, help="Optional Inspect log directory")
    args = parser.parse_args()
    if args.wait_seconds < 1 or args.wait_seconds > 1800:
        parser.error("--wait-seconds must be between 1 and 1800")
    for value, label in ((args.tenant_id, "tenant-id"), (args.run_id, "run-id")):
        if len(value) != 36 or value.count("-") != 4:
            parser.error(f"--{label} must be a UUID")
    base_url = os.environ.get("ASTRA_EVAL_BASE_URL", "").strip()
    cookie = os.environ.get("ASTRA_INSPECT_COOKIE", "").strip()
    csrf = os.environ.get("ASTRA_INSPECT_CSRF_TOKEN", "").strip()
    if not base_url or not cookie or not csrf:
        parser.error("Set ASTRA_EVAL_BASE_URL, ASTRA_INSPECT_COOKIE, and ASTRA_INSPECT_CSRF_TOKEN in the environment.")
    try:
        safe_url = _safe_base_url(base_url)
        inspect_eval, task = _build_inspect_task(safe_url, cookie, csrf, args.tenant_id, args.run_id, args.wait_seconds)
        logs = inspect_eval(task, model=None, log_dir=args.log_dir, limit=1, fail_on_error=True)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({"inspectLogs": len(logs), "tenantId": args.tenant_id, "runId": args.run_id,
                      "providerCalls": False, "rawPacketsLogged": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

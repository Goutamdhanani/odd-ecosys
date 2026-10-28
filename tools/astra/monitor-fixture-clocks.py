"""Keep only verified disposable PG processes aligned with the Windows host.

No system clock changes. Committed fixture data and credentials are retained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--keepalive', action='store_true')
args = parser.parse_args()
repo = Path(args.repo).resolve()
if os.getuid() != 0:
    raise SystemExit('Use the verified WSL setup context.')
binary = Path('/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin')
clock_library = Path('/var/tmp/odd-astra-preview-clock/root/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1')
ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

def sync_once():
    host_raw = subprocess.check_output([ps, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command', '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()'], text=True, timeout=10).strip()
    if not host_raw.isdigit():
        raise RuntimeError('Host clock query did not return an epoch.')
    offset = round(int(host_raw) / 1000 - time.time())
    if abs(offset) > 86400:
        raise RuntimeError('Clock relationship exceeds the fixture bound.')
    preview_file = repo / '.runner/astra-preview/pg.json'
    preview = json.loads(preview_file.read_text())
    states = [preview_file, *sorted((repo / '.runner/astra-qa').glob('*/pg.json'))]
    changed = 0
    for state_file in states:
        state = json.loads(state_file.read_text())
        mode = state.get('mode')
        fixture = Path(state.get('fixture') or state.get('clusterFixture') or '/invalid').resolve()
        expected_prefix = 'odd-astra-preview-pg-' if mode == 'disposable-synthetic-preview' else 'odd-astra-qa-pg-'
        if (mode not in ['disposable-synthetic-preview', 'disposable-synthetic-qa']
                or fixture.parent != Path('/var/tmp') or not fixture.name.startswith(expected_prefix)
                or Path(state.get('binary', '')).resolve() != binary):
            continue
        if abs(int(state.get('previewClockOffsetSeconds', 0)) - offset) < 3:
            continue
        prefix = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath']]
        status = subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'), 'status'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if status.returncode == 0:
            subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'), '-m', 'fast', '-w', 'stop'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if offset:
            if (not clock_library.is_file()
                    or hashlib.sha256(clock_library.read_bytes()).hexdigest() != preview.get('previewClockLibrarySha256')):
                raise RuntimeError('The verified process clock library is unavailable.')
            prefix += ['LD_PRELOAD=' + str(clock_library), 'FAKETIME=' + format(offset, '+d'),
                       'FAKETIME_DONT_FAKE_MONOTONIC=1']
        subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'),
            '-l', str(fixture / 'postgres.log'), '-o', '-k ' + str(fixture / 'socket')
            + ' -p ' + str(state['port']) + ' -c listen_addresses=127.0.0.1 -c jit=off', '-w', 'start'],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        fresh = json.loads(state_file.read_text())
        fresh['previewClockOffsetSeconds'] = offset
        fresh['clockAlignmentMode'] = 'monitored-disposable-process-only'
        temporary = state_file.with_suffix('.clock-tmp')
        temporary.write_text(json.dumps(fresh, indent=2))
        os.chmod(temporary, 0o600)
        temporary.replace(state_file)
        changed += 1
    return {'aligned': True, 'processOffsetSeconds': offset, 'restartedFixtures': changed,
            'systemClockChanged': False, 'realData': False}

while True:
    try:
        result = sync_once()
        if result['restartedFixtures'] or not args.keepalive:
            print(json.dumps(result), flush=True)
    except Exception as error:
        print(json.dumps({'aligned': False, 'errorType': type(error).__name__,
                          'privateDiagnosticsSuppressed': True}), flush=True)
        if not args.keepalive:
            raise SystemExit(1)
    if not args.keepalive:
        break
    time.sleep(5)

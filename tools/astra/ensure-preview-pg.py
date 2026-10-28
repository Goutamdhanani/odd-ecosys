"""Keep the existing disposable preview database available in WSL. No migration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--keepalive', action='store_true')
parser.add_argument('--clock-offset', type=int, help='Preview process clock alignment in seconds; never changes the system clock.')
args = parser.parse_args()
repo = Path(args.repo).resolve()
state = json.loads((repo / '.runner/astra-preview/pg.json').read_text())
fixture = Path(state['fixture']).resolve()
binary = Path(state['binary']).resolve()
expected = Path('/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin')
url = urlsplit(state['connectionString'])
if (os.getuid() != 0 or state.get('mode') != 'disposable-synthetic-preview'
        or fixture.parent != Path('/var/tmp')
        or not fixture.name.startswith('odd-astra-preview-pg-')
        or binary != expected or not (fixture / 'data/PG_VERSION').is_file()
        or url.hostname != '127.0.0.1' or url.path != '/odd_astra_preview'
        or url.port != state['port']):
    raise SystemExit('Refusing an unrecognized preview fixture.')
prefix = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath']]
status = subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'), 'status'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
offset = args.clock_offset if args.clock_offset is not None else state.get('previewClockOffsetSeconds', 0)
if not -86400 <= offset <= 86400:
    raise SystemExit('Preview clock alignment must remain within one day.')
if args.clock_offset is not None and status.returncode == 0:
    subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'), '-m', 'fast', '-w', 'stop'],
                   check=True, stdout=subprocess.DEVNULL)
    status = subprocess.CompletedProcess([], 3)
if offset:
    private = Path('/var/tmp/odd-astra-preview-clock')
    library = private / 'root/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1'
    if not library.is_file():
        (private / 'debs').mkdir(parents=True, exist_ok=True)
        subprocess.run(['apt-get', 'download', 'libfaketime'], cwd=private / 'debs', check=True,
                       stdout=subprocess.DEVNULL)
        packages = list((private / 'debs').glob('libfaketime_*.deb'))
        if len(packages) != 1:
            raise SystemExit('Expected exactly one private clock package.')
        subprocess.run(['dpkg-deb', '-x', str(packages[0]), str(private / 'root')], check=True)
        state['previewClockPackageSha256'] = hashlib.sha256(packages[0].read_bytes()).hexdigest()
        state['previewClockPackageVersion'] = subprocess.check_output(
            ['dpkg-deb', '-f', str(packages[0]), 'Version'], text=True).strip()
    prefix += ['LD_PRELOAD=' + str(library), 'FAKETIME=' + format(offset, '+d'),
               'FAKETIME_DONT_FAKE_MONOTONIC=1']
    state['previewClockOffsetSeconds'] = offset
    state['previewClockLibrarySha256'] = hashlib.sha256(library.read_bytes()).hexdigest()
    (repo / '.runner/astra-preview/pg.json').write_text(json.dumps(state, indent=2))
if status.returncode != 0:
    subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'),
        '-l', str(fixture / 'postgres.log'), '-o', '-k ' + str(fixture / 'socket')
        + ' -p ' + str(state['port']) + ' -c listen_addresses=127.0.0.1 -c jit=off',
        '-w', 'start'], check=True, stdout=subprocess.DEVNULL)
print(json.dumps({'ready': True, 'realData': False, 'migrationsRun': False,
                  'previewClockOffsetSeconds': offset, 'systemClockChanged': False}), flush=True)
if args.keepalive:
    while True:
        time.sleep(20)

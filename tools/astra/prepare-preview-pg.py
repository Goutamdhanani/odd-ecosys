"""Create a brand-new local-only PostgreSQL fixture for the feature preview.

Run inside Ubuntu WSL. Never accepts a customer database URL or source data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--apply-new', action='store_true')
parser.add_argument('--through', type=int, help='Apply only finalized migration numbers through this value.')
parser.add_argument('--only', type=int, nargs='+', help='Select explicit finalized, dependency-ready migration numbers.')
args = parser.parse_args()
repo = Path(args.repo).resolve()
if args.through is not None and not 1 <= args.through <= 999:
    raise SystemExit('--through must be between 1 and 999.')
def finalized_migrations():
    items = sorted((repo / 'migrations/astra').glob('*.up.sql'))
    return [p for p in items if (args.through is None or int(p.name.split('-', 1)[0]) <= args.through)
            and (args.only is None or int(p.name.split('-', 1)[0]) in args.only)]
if not (repo / 'pipeline/astra-tenant-store.js').is_file():
    raise SystemExit('Expected Astra implementation checkout.')
if os.getuid() != 0:
    raise SystemExit('Use the isolated WSL root context to unpack and run as nobody.')
if args.apply_new:
    state_file = repo / '.runner/astra-preview/pg.json'
    state = json.loads(state_file.read_text(encoding='utf-8'))
    fixture = Path(state['fixture']).resolve()
    if state.get('mode') != 'disposable-synthetic-preview' or fixture.parent != Path('/var/tmp') or not fixture.name.startswith('odd-astra-preview-pg-'):
        raise SystemExit('Refusing an unrecognized database fixture.')
    prefix = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath']]
    psql = prefix + [str(Path(state['binary']) / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(fixture / 'socket'), '-p', str(state['port']), '-U', 'astra_preview_admin', '-d', 'odd_astra_preview']
    existing = {item['file']: item['sha256'] for item in state['migrations']}
    for filename, digest in existing.items():
        installed = repo / 'migrations/astra' / filename
        if not installed.is_file() or hashlib.sha256(installed.read_bytes()).hexdigest() != digest:
            raise SystemExit('Applied migration changed; preserve fixture and repair additively: ' + filename)
    if not state.get('workerConnectionString'):
        worker_password = secrets.token_hex(32)
        subprocess.run(psql, input=f"CREATE ROLE astra_preview_worker LOGIN PASSWORD '{worker_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT astra_worker TO astra_preview_worker;\n", text=True, check=True, stdout=subprocess.DEVNULL)
        state['workerConnectionString'] = f"postgresql://astra_preview_worker:{worker_password}@127.0.0.1:{state['port']}/odd_astra_preview"
        state_file.write_text(json.dumps(state, indent=2), encoding='utf-8')
    added = []
    for migration in finalized_migrations():
        digest = hashlib.sha256(migration.read_bytes()).hexdigest()
        if migration.name in existing:
            if digest != existing[migration.name]:
                raise SystemExit('Applied migration changed; rebuild disposable fixture explicitly: ' + migration.name)
            continue
        subprocess.run(psql, input=migration.read_text(encoding='utf-8-sig'), text=True, check=True, stdout=subprocess.DEVNULL)
        state['migrations'].append({'file': migration.name, 'sha256': digest})
        state_file.write_text(json.dumps(state, indent=2), encoding='utf-8')
        added.append(migration.name)
    print(json.dumps({'ready': True, 'migrationsApplied': added, 'realData': False}))
    raise SystemExit(0)
base = Path('/var/tmp/odd-astra-preview-pg16-tools')
(base / 'debs').mkdir(parents=True, exist_ok=True)
(base / 'root').mkdir(exist_ok=True)
binary = base / 'root/usr/lib/postgresql/16/bin'
if not (binary / 'initdb').is_file():
    subprocess.run(['apt-get', 'download', 'postgresql-16=16.15-0ubuntu0.24.04.1',
                    'postgresql-client-16=16.15-0ubuntu0.24.04.1', 'libpq5=16.15-0ubuntu0.24.04.1'],
                   cwd=base / 'debs', check=True)
    for package in (base / 'debs').glob('*.deb'):
        subprocess.run(['dpkg-deb', '-x', str(package), str(base / 'root')], check=True)
fixture = Path(tempfile.mkdtemp(prefix='odd-astra-preview-pg-', dir='/var/tmp'))
os.chown(fixture, 65534, 65534)
os.chmod(fixture, 0o700)
sock = fixture / 'socket'
sock.mkdir()
os.chown(sock, 65534, 65534)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
prefix = ['runuser', '-u', 'nobody', '--', 'env',
          'LD_LIBRARY_PATH=' + str(base / 'root/usr/lib/x86_64-linux-gnu')]
subprocess.run(prefix + [str(binary / 'initdb'), '-D', str(fixture / 'data'),
                       '-L', str(base / 'root/usr/share/postgresql/16'), '-U', 'astra_preview_admin',
                       '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'],
               check=True, stdout=subprocess.DEVNULL)
subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'),
                       '-l', str(fixture / 'postgres.log'), '-o',
                       "-k " + str(sock) + " -p " + str(port) + " -c listen_addresses=127.0.0.1 -c jit=off", '-w', 'start'], check=True)
psql = prefix + [str(binary / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
                 '-h', str(sock), '-p', str(port), '-U', 'astra_preview_admin', '-d', 'postgres']
subprocess.run(psql, input='CREATE DATABASE odd_astra_preview;\n', text=True, check=True, stdout=subprocess.DEVNULL)
psql[-1] = 'odd_astra_preview'
applied = []
for migration in finalized_migrations():
    content = migration.read_text(encoding='utf-8-sig')
    subprocess.run(psql, input=content, text=True, check=True, stdout=subprocess.DEVNULL)
    applied.append({'file': migration.name, 'sha256': hashlib.sha256(migration.read_bytes()).hexdigest()})
password = secrets.token_hex(32)
worker_password = secrets.token_hex(32)
secret = secrets.token_hex(32)
setup = f"""CREATE ROLE astra_preview_login LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT astra_app TO astra_preview_login;
CREATE ROLE astra_preview_worker LOGIN PASSWORD '{worker_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT astra_worker TO astra_preview_worker;
SET ROLE astra_owner;
SELECT astra.install_context_verifier(convert_to('{secret}','UTF8'));
RESET ROLE;
"""
subprocess.run(psql, input=setup, text=True, check=True, stdout=subprocess.DEVNULL)
output = repo / '.runner/astra-preview'
output.mkdir(parents=True, exist_ok=True)
state = {'connectionString': f'postgresql://astra_preview_login:{password}@127.0.0.1:{port}/odd_astra_preview',
         'workerConnectionString': f'postgresql://astra_preview_worker:{worker_password}@127.0.0.1:{port}/odd_astra_preview',
         'contextSecret': secret, 'port': port, 'fixture': str(fixture), 'binary': str(binary),
         'libraryPath': str(base / 'root/usr/lib/x86_64-linux-gnu'), 'migrations': applied,
         'mode': 'disposable-synthetic-preview'}
(output / 'pg.json').write_text(json.dumps(state, indent=2), encoding='utf-8')
print(json.dumps({'ready': True, 'port': port, 'migrationsApplied': [item['file'] for item in applied], 'realData': False}))

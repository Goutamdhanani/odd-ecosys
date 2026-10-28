"""Provision a separate synthetic QA cluster using verified preview binaries.

Never connects to a supplied URL or reads/copies a customer database.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--label', required=True)
parser.add_argument('--through', type=int, help='Include only finalized migrations through this number.')
args = parser.parse_args()
if not re.fullmatch(r'[a-z][a-z0-9-]{0,23}', args.label):
    raise SystemExit('Use a short lowercase QA label.')
repo = Path(args.repo).resolve()
state = json.loads((repo / '.runner/astra-preview/pg.json').read_text())
fixture = Path(state['fixture']).resolve()
binary = Path(state['binary']).resolve()
if (os.getuid() != 0 or state.get('mode') != 'disposable-synthetic-preview'
        or fixture.parent != Path('/var/tmp')
        or not fixture.name.startswith('odd-astra-preview-pg-')
        or binary != Path('/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin')):
    raise SystemExit('Refusing an unrecognized synthetic cluster.')
output = repo / '.runner/astra-qa' / args.label
output.mkdir(parents=True, exist_ok=True)
state_file = output / 'pg.json'
if state_file.exists():
    existing = json.loads(state_file.read_text())
    previous_fixture = Path(existing.get('clusterFixture', '/invalid')).resolve()
    if (existing.get('mode') != 'disposable-synthetic-qa'
            or existing.get('parentPreviewFixture') != str(fixture)
            or previous_fixture.parent != Path('/var/tmp')
            or not previous_fixture.name.startswith('odd-astra-qa-pg-')):
        raise SystemExit('Refusing to replace unrelated QA state.')
    print(json.dumps({'ready': True, 'reused': True, 'label': args.label, 'realData': False}))
    raise SystemExit(0)
suffix = args.label.replace('-', '_') + '_' + secrets.token_hex(4)
database = 'odd_astra_qa_' + suffix
app_login = 'astra_qa_app_' + suffix
worker_login = 'astra_qa_worker_' + suffix
parent_fixture = fixture
fixture = Path(tempfile.mkdtemp(prefix='odd-astra-qa-pg-', dir='/var/tmp'))
os.chown(fixture, 65534, 65534)
os.chmod(fixture, 0o700)
sock = fixture / 'socket'
sock.mkdir()
os.chown(sock, 65534, 65534)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
prefix = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath']]
offset = state.get('previewClockOffsetSeconds', 0)
if offset:
    clock_library = Path('/var/tmp/odd-astra-preview-clock/root/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1')
    if not clock_library.is_file() or hashlib.sha256(clock_library.read_bytes()).hexdigest() != state.get('previewClockLibrarySha256'):
        raise SystemExit('The verified preview clock library is unavailable.')
    prefix += ['LD_PRELOAD=' + str(clock_library), 'FAKETIME=' + format(offset, '+d'), 'FAKETIME_DONT_FAKE_MONOTONIC=1']
subprocess.run(prefix + [str(binary / 'initdb'), '-D', str(fixture / 'data'),
    '-L', '/var/tmp/odd-astra-preview-pg16-tools/root/usr/share/postgresql/16',
    '-U', 'astra_qa_admin', '--auth-local=trust', '--auth-host=scram-sha-256',
    '--encoding=UTF8', '--locale=C'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(prefix + [str(binary / 'pg_ctl'), '-D', str(fixture / 'data'),
    '-l', str(fixture / 'postgres.log'), '-o', '-k ' + str(sock) + ' -p ' + str(port)
    + ' -c listen_addresses=127.0.0.1 -c jit=off', '-w', 'start'], check=True, stdout=subprocess.DEVNULL)
psql = prefix + [str(binary / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
                '-h', str(sock), '-p', str(port),
                '-U', 'astra_qa_admin', '-d', 'postgres']

def run_sql(sql, step, private=False):
    result = subprocess.run(psql, input=sql, text=True, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    if result.returncode:
        if not private:
            print(result.stderr[-2500:])
        raise SystemExit('QA fixture preparation failed: ' + step)

run_sql('CREATE DATABASE ' + database + ';', 'create synthetic database')
psql[-1] = database
migrations = []
for migration in sorted((repo / 'migrations/astra').glob('*.up.sql')):
    if args.through is not None and int(migration.name.split('-', 1)[0]) > args.through:
        continue
    run_sql(migration.read_text(encoding='utf-8-sig'), migration.name)
    migrations.append({'file': migration.name, 'sha256': hashlib.sha256(migration.read_bytes()).hexdigest()})
app_password, worker_password, context_secret = (secrets.token_hex(32) for _ in range(3))
run_sql(f"""CREATE ROLE {app_login} LOGIN PASSWORD '{app_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT astra_app TO {app_login};
CREATE ROLE {worker_login} LOGIN PASSWORD '{worker_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT astra_worker TO {worker_login};
SET ROLE astra_owner;
SELECT astra.install_context_verifier(convert_to('{context_secret}','UTF8'));
RESET ROLE;
""", 'private synthetic role/context setup', private=True)
payload = {'mode': 'disposable-synthetic-qa', 'clusterFixture': str(fixture),
           'parentPreviewFixture': str(parent_fixture), 'binary': str(binary),
           'libraryPath': state['libraryPath'],
           'databaseName': database, 'port': port, 'label': args.label,
           'connectionString': f'postgresql://{app_login}:{app_password}@127.0.0.1:{port}/{database}',
           'workerConnectionString': f'postgresql://{worker_login}:{worker_password}@127.0.0.1:{port}/{database}',
           'contextSecret': context_secret, 'migrations': migrations,
           'previewClockOffsetSeconds': state.get('previewClockOffsetSeconds', 0),
           'realData': False}
state_file.write_text(json.dumps(payload, indent=2))
os.chmod(state_file, 0o600)
print(json.dumps({'ready': True, 'label': args.label, 'database': database,
                  'migrations': len(migrations), 'realData': False}))

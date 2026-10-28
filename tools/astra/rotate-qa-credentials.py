"""Rotate credentials for a verified disposable synthetic QA cluster only."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from urllib.parse import urlsplit, urlunsplit

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--label', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-z][a-z0-9-]{0,23}', args.label):
    raise SystemExit('Invalid synthetic QA label.')
repo = Path(args.repo).resolve()
state_file = repo / '.runner/astra-qa' / args.label / 'pg.json'
state = json.loads(state_file.read_text())
fixture = Path(state['clusterFixture']).resolve()
binary = Path(state['binary']).resolve()
app = urlsplit(state['connectionString'])
worker = urlsplit(state['workerConnectionString'])
database = state['databaseName']
suffix = database.removeprefix('odd_astra_qa_')
if (os.getuid() != 0 or state.get('mode') != 'disposable-synthetic-qa'
        or state.get('realData') is not False or state.get('label') != args.label
        or fixture.parent != Path('/var/tmp') or not fixture.name.startswith('odd-astra-qa-pg-')
        or binary != Path('/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin')
        or not re.fullmatch(re.escape(args.label.replace('-', '_')) + r'_[0-9a-f]{8}', suffix)
        or app.hostname != '127.0.0.1' or worker.hostname != '127.0.0.1'
        or app.port != state['port'] or worker.port != state['port']
        or app.username != 'astra_qa_app_' + suffix or worker.username != 'astra_qa_worker_' + suffix
        or app.path != '/' + database or worker.path != app.path):
    raise SystemExit('Refusing an unrecognized disposable QA fixture.')
app_password, worker_password, context_secret = (secrets.token_hex(32) for _ in range(3))
psql = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath'],
        str(binary / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', str(fixture / 'socket'),
        '-p', str(state['port']), '-U', 'astra_qa_admin', '-d', database]
sql = f"""BEGIN;
ALTER ROLE {app.username} PASSWORD '{app_password}';
ALTER ROLE {worker.username} PASSWORD '{worker_password}';
SET LOCAL ROLE astra_owner;
UPDATE astra.context_keys SET secret=convert_to('{context_secret}','UTF8') WHERE singleton=true;
COMMIT;
SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
WHERE datname='{database}' AND usename IN ('{app.username}','{worker.username}')
AND pid<>pg_catalog.pg_backend_pid();
"""
result = subprocess.run(psql, input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
if result.returncode:
    raise SystemExit('Synthetic QA credential rotation failed; private diagnostics suppressed.')
state['connectionString'] = urlunsplit(app._replace(netloc=f'{app.username}:{app_password}@127.0.0.1:{state["port"]}'))
state['workerConnectionString'] = urlunsplit(worker._replace(netloc=f'{worker.username}:{worker_password}@127.0.0.1:{state["port"]}'))
state['contextSecret'] = context_secret
state['credentialRotationSequence'] = int(state.get('credentialRotationSequence', 0)) + 1
state_file.write_text(json.dumps(state, indent=2))
os.chmod(state_file, 0o600)
print(json.dumps({'rotated': True, 'label': args.label, 'realData': False, 'dataRetained': True,
                  'scope': 'disposable-synthetic-qa-only', 'sequence': state['credentialRotationSequence']}))

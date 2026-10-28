"""Rotate only this task's verified synthetic preview credentials; retain data."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit, urlunsplit

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
args = parser.parse_args()
repo = Path(args.repo).resolve()
state_file = repo / '.runner/astra-preview/pg.json'
state = json.loads(state_file.read_text())
fixture = Path(state['fixture']).resolve()
binary = Path(state['binary']).resolve()
app = urlsplit(state['connectionString'])
worker = urlsplit(state['workerConnectionString'])
if (os.getuid() != 0 or state.get('mode') != 'disposable-synthetic-preview'
        or fixture.parent != Path('/var/tmp')
        or not fixture.name.startswith('odd-astra-preview-pg-')
        or binary != Path('/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin')
        or app.hostname != '127.0.0.1' or worker.hostname != '127.0.0.1'
        or app.username != 'astra_preview_login' or worker.username != 'astra_preview_worker'
        or app.path != '/odd_astra_preview' or worker.path != app.path):
    raise SystemExit('Refusing an unrecognized synthetic fixture.')
app_password, worker_password, context_secret = (secrets.token_hex(32) for _ in range(3))
psql = ['runuser', '-u', 'nobody', '--', 'env', 'LD_LIBRARY_PATH=' + state['libraryPath'],
        str(binary / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', str(fixture / 'socket'),
        '-p', str(state['port']), '-U', 'astra_preview_admin', '-d', 'odd_astra_preview']
sql = f"""BEGIN;
ALTER ROLE astra_preview_login PASSWORD '{app_password}';
ALTER ROLE astra_preview_worker PASSWORD '{worker_password}';
SET LOCAL ROLE astra_owner;
UPDATE astra.context_keys SET secret=convert_to('{context_secret}','UTF8') WHERE singleton=true;
COMMIT;
SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
WHERE datname='odd_astra_preview' AND usename IN ('astra_preview_login','astra_preview_worker')
AND pid<>pg_catalog.pg_backend_pid();
"""
result = subprocess.run(psql, input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
if result.returncode:
    raise SystemExit('Synthetic credential rotation failed; private diagnostics were suppressed.')
state['connectionString'] = urlunsplit(app._replace(netloc=f'{app.username}:{app_password}@127.0.0.1:{state["port"]}'))
state['workerConnectionString'] = urlunsplit(worker._replace(netloc=f'{worker.username}:{worker_password}@127.0.0.1:{state["port"]}'))
state['contextSecret'] = context_secret
state['credentialRotationSequence'] = int(state.get('credentialRotationSequence', 0)) + 1
state_file.write_text(json.dumps(state, indent=2))
os.chmod(state_file, 0o600)
print(json.dumps({'rotated': True, 'realData': False, 'dataRetained': True,
                  'scope': 'synthetic-preview-only', 'sequence': state['credentialRotationSequence']}))

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const locationFile = path.join(os.homedir(), '.codex', 'odd-ecosys-runtime-location.json');
export function runtimePath() {
  if (process.env.ODD_RUNNER_ROOT) return path.resolve(process.env.ODD_RUNNER_ROOT);
  try { return JSON.parse(fs.readFileSync(locationFile, 'utf8')).runtime; }
  catch { return path.join(os.homedir(), '.codex', 'odd-ecosys-runtime'); }
}

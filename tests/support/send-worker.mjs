import { parentPort, workerData } from 'node:worker_threads';

process.env.ODD_DB_PATH = workerData.databasePath;
process.env.NODE_ENV = 'test';
process.env.ODD_SEND_MAX_DAILY_PER_DOMAIN = String(workerData.domainLimit);
process.env.ODD_SEND_WINDOW_TIMEZONE = 'UTC';
process.env.ODD_SEND_WINDOW_START_HOUR = '0';
process.env.ODD_SEND_WINDOW_END_HOUR = '24';
process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY = 'false';

const { initDb, closeDb } = await import('../../pipeline/database.js');
initDb();
const engine = await import('../../pipeline/sending-engine.js');
try {
  parentPort.postMessage(await engine.processSendQueue({ limit: 10 }));
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  closeDb();
}

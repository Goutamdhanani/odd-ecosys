// Keep unrelated loopback transport tests independent of the machine's current local time.
// The schedule policy itself is covered with deterministic timezone tests in sending-schedule.test.mjs.
process.env.ODD_SEND_WINDOW_TIMEZONE = 'UTC';
process.env.ODD_SEND_WINDOW_START_HOUR = '0';
process.env.ODD_SEND_WINDOW_END_HOUR = '24';
process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY = 'false';
process.env.ODD_SEND_TEST_PACING_MS = '0';

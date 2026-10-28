SET ROLE astra_owner;

DROP TABLE IF EXISTS astra.crm_attempts;
DROP TABLE IF EXISTS astra.crm_outbox;
DROP TABLE IF EXISTS astra.crm_mappings;
DROP TABLE IF EXISTS astra.crm_settings;
DROP TABLE IF EXISTS astra.reply_tasks;
DROP TABLE IF EXISTS astra.inbox_messages;
DROP TABLE IF EXISTS astra.inbox_threads;
DROP TABLE IF EXISTS astra.mailboxes;
DROP TABLE IF EXISTS astra.suppression_decisions;
DROP TABLE IF EXISTS astra.permission_decisions;
DROP FUNCTION IF EXISTS astra.guard_inbox_state_update();
DROP FUNCTION IF EXISTS astra.reject_inbox_append_only_mutation();

RESET ROLE;

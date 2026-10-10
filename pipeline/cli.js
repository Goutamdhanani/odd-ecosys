// ============================================================
//  ODD-ECOSYS Pipeline — Master CLI Interface
//  Comprehensive CLI for all 9 pipeline phases & control plane
//
//  Usage:
//    node pipeline/cli.js discover --niche "dentists" --geo "Austin TX" (disabled until an approved source is configured)
//    node pipeline/cli.js import --csv ./data/leads.csv --batch-name "Test"
//    node pipeline/cli.js qualify --batch-id 4
//    node pipeline/cli.js verify --batch-id 4
//    node pipeline/cli.js personalize --batch-id 4
//    node pipeline/cli.js queue-sends --campaign-id 1 --limit 50
//    node pipeline/cli.js process-sends --limit 50
//    node pipeline/cli.js reply --from "lead@example.com" --body "Sounds great, send me info"
//    node pipeline/cli.js suppress --email "optout@example.com"
//    node pipeline/cli.js archive-batch --batch-id 4
//    node pipeline/cli.js crm-sync --lead-id 1
//    node pipeline/cli.js kill-switch
//    node pipeline/cli.js stats
// ============================================================

import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDbStats, closeDb } from './database.js';
import { discoverLeads, importLeads } from './lead-discovery.js';
import { qualifyBatch, requalifyLead, requeueStaleLeads } from './qualifier.js';
import { verifyBatch, verifyEmail as verifySingleEmail } from './email-verifier.js';
import { personalizeBatch } from './personalizer.js';
import { seedDatabase } from './seed.js';
import { generateTemplate } from './csv-importer.js';
import { queueSends, processSendQueue, recomputeHealthScores, getCampaignPreflight } from './sending-engine.js';
import { ingestInboundReply } from './reply-tracker.js';
import { suppressEmail, listSuppressed } from './compliance.js';
import { archiveBatch, getArchiveStats } from './archiver.js';
import { syncLeadToCRM, emergencyKillSwitch, blacklistDomain } from './crm-sync.js';
import { getBatchStats, listBatches } from './batch-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {};
  const positional = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      args[key] = argv[++i] || true;
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0], args };
}

async function main() {
  const { command, args } = parseArgs(process.argv);

  try {
    if (!command || command === 'help') { printHelp(); return; }
    if (command === 'template') {
      if (!args.output) throw new Error('--output required');
      generateTemplate(path.resolve(args.output));
      return;
    }
    const commands = ['discover', 'import', 'seed', 'batch-status', 'qualify', 'verify', 'personalize', 'queue-sends', 'process-sends', 'reply', 'suppress', 'archive-batch', 'crm-sync', 'kill-switch', 'stats'];
    if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);
    if (command === 'seed' && (process.env.NODE_ENV !== 'test' || !process.env.ODD_DB_PATH)) {
      throw new Error('Seed requires NODE_ENV=test and an explicit ODD_DB_PATH for a fixture database');
    }
    initDb();
    switch (command) {
      case 'import': {
        if (!args.csv) throw new Error('--csv required');
        const res = await importLeads({
          csvPath: path.resolve(args.csv),
          batchName: args['batch-name'] || 'CSV import',
          options: { skipEnrichment: !!args['skip-enrichment'], dryRun: !!args['dry-run'] },
        });
        console.log('Import complete:', res);
        break;
      }
      case 'seed': {
        seedDatabase();
        break;
      }
      case 'batch-status': {
        const batchId = args['batch-id'] || args.b;
        if (batchId) {
          const stats = getBatchStats(Number(batchId));
          if (!stats) throw new Error(`Batch #${batchId} not found`);
          console.log(stats);
        } else console.table(listBatches());
        break;
      }
      case 'discover': {
        const niche = args.niche || args.n;
        const geography = args.geo || args.g;
        if (!niche || !geography) throw new Error('--niche and --geo required');
        const res = await discoverLeads({ niche, geography, options: args });
        console.log('✅ Discovery complete:', res);
        break;
      }

      case 'qualify': {
        const batchId = parseInt(args['batch-id'] || args.b || 1);
        const res = await qualifyBatch(batchId, args);
        console.log('✅ Qualification complete:', res);
        break;
      }

      case 'verify': {
        if (args.email) {
          const res = await verifySingleEmail(args.email);
          console.log('✅ Email verification result:', res);
        } else {
          const batchId = parseInt(args['batch-id'] || args.b || 1);
          const res = await verifyBatch(batchId, args);
          console.log('✅ Batch verification complete:', res);
        }
        break;
      }

      case 'personalize': {
        const batchId = parseInt(args['batch-id'] || args.b || 1);
        const res = await personalizeBatch(batchId, args);
        console.log('✅ Personalization complete:', res);
        break;
      }

      case 'queue-sends': {
        const campaignId = parseInt(args['campaign-id'] || args.c || 1);
        const limit = parseInt(args.limit || 50);
        const review = getCampaignPreflight(campaignId);
        console.log('Campaign preflight:', review.counts, review.blockers);
        if (!review.ready) throw new Error('Campaign preflight has blockers; resolve them before queueing.');
        const res = await queueSends(campaignId, { limit, reviewHash: review.reviewHash });
        console.log('✅ Sends queued:', res);
        break;
      }

      case 'process-sends': {
        const limit = parseInt(args.limit || 50);
        const res = await processSendQueue({ limit });
        console.log('✅ Queue processed:', res);
        break;
      }

      case 'reply': {
        const fromEmail = args.from;
        const body = args.body || 'Interested, please send more details.';
        if (!fromEmail) throw new Error('--from email required');
        const res = await ingestInboundReply({ fromEmail, body });
        console.log('✅ Reply ingested & classified:', res);
        break;
      }

      case 'suppress': {
        const email = args.email;
        if (!email) throw new Error('--email required');
        suppressEmail(email, args.reason || 'cli_manual');
        console.log(`✅ ${email} added to global suppression list`);
        break;
      }

      case 'archive-batch': {
        const batchId = parseInt(args['batch-id'] || args.b);
        if (!batchId) throw new Error('--batch-id required');
        const res = archiveBatch(batchId);
        console.log('✅ Batch archived & database vacuumed:', res);
        break;
      }

      case 'crm-sync': {
        const leadId = parseInt(args['lead-id'] || args.l || 1);
        const res = await syncLeadToCRM(leadId);
        console.log('✅ Lead synced to CRM:', res);
        break;
      }

      case 'kill-switch': {
        const res = emergencyKillSwitch('cli_emergency_halt');
        console.log('🚨 EMERGENCY KILL-SWITCH ACTIVATED:', res);
        break;
      }

      case 'stats': {
        const stats = getDbStats();
        const archStats = getArchiveStats();
        console.log('\n📊 Pipeline Database Stats:');
        console.table(stats);
        console.log('\n📦 Archive Stats:');
        console.table(archStats);
        break;
      }

      default:
        printHelp();
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

function printHelp() {
  console.log(`
ODD-ECOSYS Pipeline CLI
Commands:
  discover      disabled: use an authorized source CSV until a permitted provider is configured
  import        --csv ./data/leads.csv --batch-name "My Batch"
                --skip-enrichment (no external website requests)
  seed          fixture database only: NODE_ENV=test and ODD_DB_PATH required
  batch-status  [--batch-id 1]
  template      --output ./leads-template.csv
  qualify       --batch-id 1
  verify        --batch-id 1 | --email user@example.com
  personalize   --batch-id 1
  queue-sends   --campaign-id 1 --limit 50
  process-sends --limit 50
  reply         --from "lead@biz.com" --body "Yes, let's talk"
  suppress      --email "optout@biz.com"
  archive-batch --batch-id 1
  crm-sync      --lead-id 1
  kill-switch
  stats
  `);
}

main();

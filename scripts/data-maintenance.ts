/**
 * Operator CLI for the storage under DATA_DIR.
 *
 *   npm run data:check                       consistency report (exit 1 when there are issues)
 *   npm run data:sweep                       dry run: what a sweep would remove
 *   npm run data:sweep:apply                 remove it (orphans, abandoned tmp, old versions)
 *   npm run data:sweep -- --older-than-days 60
 *
 * Retention defaults to DATA_RETENTION_DAYS (30). The latest version of every
 * project is never touched.
 */
import { createStorageFromEnv } from '../lib/assets/index.js';
import { getPrisma } from '../lib/db/prisma.js';
import { checkData, sweepData } from '../lib/maintenance/index.js';

const DEFAULT_RETENTION_DAYS = 30;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const [command = 'check', ...args] = process.argv.slice(2);
  // Only the storage root matters here; the provider/ffmpeg configuration must not block maintenance.
  const storage = createStorageFromEnv();

  if (command === 'check') {
    const report = await checkData(storage);
    console.log(`Checked ${report.counts.videos} videos, ${report.counts.readyAssets} ready assets, ${report.counts.dirs} directories under ${storage.root}`);
    for (const issue of report.issues) {
      console.log(`  ${issue.code.padEnd(24)} ${issue.detail}`);
    }
    console.log(report.issues.length === 0 ? 'No issues.' : `${report.issues.length} issue(s).`);
    return report.issues.length === 0 ? 0 : 1;
  }

  if (command === 'sweep') {
    const apply = args.includes('--apply');
    const rawDays = option(args, '--older-than-days') ?? process.env['DATA_RETENTION_DAYS'];
    const retentionDays = rawDays ? Number(rawDays) : DEFAULT_RETENTION_DAYS;
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      console.error('--older-than-days / DATA_RETENTION_DAYS must be a whole number of days (at least 1)');
      return 2;
    }
    const report = await sweepData(storage, { dryRun: !apply, retentionDays, log: console.log });
    const failed = report.actions.filter((action) => action.error).length;
    console.log(
      `${report.dryRun ? 'Would remove' : 'Removed'} ${report.actions.length} item(s) under ${storage.root} (retention ${retentionDays} days)` +
        (failed ? `; ${failed} failed` : '') +
        (report.dryRun && report.actions.length > 0 ? '. Run with --apply to do it.' : ''),
    );
    return failed ? 1 : 0;
  }

  console.error('Usage: data-maintenance <check | sweep [--apply] [--older-than-days N]>');
  return 2;
}

main()
  .then(async (code) => {
    await getPrisma().$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await getPrisma().$disconnect();
    process.exit(1);
  });

import { planReactiveV07Migration, applyReactiveV07Migration } from '../src/lib/reactive/migrate-v07';
import { prisma } from '../src/lib/db';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply') || args.filter((arg) => arg === '--apply').length > 1) {
  throw new Error('Usage: npm run reactive:migrate-v07 -- [--apply]');
}

try {
  const plan = await planReactiveV07Migration();
  console.log(JSON.stringify({ alreadyApplied: plan.alreadyApplied, count: plan.rows.length, blockers: plan.blockers }));
  if (plan.blockers.length) process.exitCode = 1;
  else if (args.includes('--apply') && !plan.alreadyApplied) {
    await applyReactiveV07Migration(plan);
    console.log('Migration committed. Run npm run search:rebuild before restarting the service.');
  }
} finally {
  await prisma.$disconnect();
}

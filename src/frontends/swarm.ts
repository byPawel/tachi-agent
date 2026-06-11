#!/usr/bin/env node
/** tachi-agent swarm: fan out role agents on one task → synthesized answer. */
import { buildSwarmFromEnv } from "../swarm/swarm.js";
import { loadUserEnv } from "../env-bootstrap.js";

async function main(): Promise<void> {
  await loadUserEnv(); // ~/.tachi/.env as defaults — real env vars win
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('usage: tachi-agent-swarm "<task>"');
    process.exit(1);
  }
  const swarm = await buildSwarmFromEnv();
  console.error(`swarm: ${swarm.roles.map((r) => r.name).join(" · ")} → synthesize  (trace ${swarm.traceId})`);
  try {
    const out = await swarm.run(task, { onMember: (m) => console.error(`  ✓ ${m.role} (${m.haltedBy})`) });
    for (const w of out.warnings ?? []) console.error(`  ⚠ ${w}`);
    process.stdout.write(out.answer + "\n");
  } finally {
    await swarm.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

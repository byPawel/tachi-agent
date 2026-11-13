#!/usr/bin/env node
/**
 * Keeps the PROMPTS tab's bundled catalog in step with tachibot.
 *
 *   node scripts/sync-techniques.mjs           regenerate src/watch/techniques.snapshot.json
 *   node scripts/sync-techniques.mjs --check   fail if the snapshot differs from tachibot's catalog
 *
 * Reads tachibot's build, so run `npm run build` in tachibot-mcp first. Set
 * TACHIBOT_MCP_DIR when tachibot-mcp isn't a sibling of this repo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const snapshotPath = path.join(root, "src", "watch", "techniques.snapshot.json");
const tachibot = path.resolve(process.env.TACHIBOT_MCP_DIR ?? path.join(root, "..", "tachibot-mcp"));
const buildPath = path.join(tachibot, "dist", "src", "tools", "prompt-technique-tools.js");

if (!fs.existsSync(buildPath)) {
  console.error(`✖ no tachibot build at ${buildPath} — build tachibot-mcp, or set TACHIBOT_MCP_DIR`);
  process.exit(1);
}
const { FLAT_TECHNIQUES: techniques } = await import(pathToFileURL(buildPath).href);
if (!Array.isArray(techniques) || !techniques.length) {
  console.error(`✖ ${buildPath} exports no FLAT_TECHNIQUES`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch (err) {
    console.error(`✖ cannot read the snapshot: ${err.message}`);
    process.exit(1);
  }
  // the techniques decide it: a tachibot release that leaves the catalog alone needs no new snapshot
  const same = current.schemaVersion === SCHEMA_VERSION && JSON.stringify(current.techniques) === JSON.stringify(techniques);
  if (!same) {
    console.error("✖ techniques.snapshot.json differs from tachibot's catalog — run: node scripts/sync-techniques.mjs");
    process.exit(1);
  }
  console.log(`✓ technique snapshot matches tachibot (${techniques.length})`);
  process.exit(0);
}

const { version: catalogVersion } = JSON.parse(fs.readFileSync(path.join(tachibot, "package.json"), "utf8"));
fs.writeFileSync(snapshotPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, catalogVersion, techniques }, null, 2)}\n`);
console.log(`✓ wrote ${techniques.length} techniques from tachibot ${catalogVersion}`);
process.exit(0);

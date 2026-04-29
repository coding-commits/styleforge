#!/usr/bin/env node
/**
 * postinstall: copies slash commands to ~/.claude/commands/
 * and prints MCP registration instructions.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const commandsSource = path.join(root, "commands");
const commandsDest = path.join(os.homedir(), ".claude", "commands");

async function main() {
  // 1. Install slash commands
  try {
    await fs.mkdir(commandsDest, { recursive: true });
    const files = await fs.readdir(commandsSource);
    let count = 0;
    for (const f of files) {
      if (f.startsWith("style-") && f.endsWith(".md")) {
        await fs.copyFile(
          path.join(commandsSource, f),
          path.join(commandsDest, f)
        );
        count++;
      }
    }
    console.log(`\n  ✓ Installed ${count} slash commands → ${commandsDest}\n`);
  } catch (err) {
    console.log(`\n  ⚠ Could not install slash commands: ${err.message}\n`);
  }

  // 2. Print MCP registration instructions
  const serverPath = path.join(root, "server", "index.js");
  const dataDir = process.env.STYLEFORGE_HOME || path.join(os.homedir(), ".styleforge");

  console.log("  To register the MCP server, run:\n");
  console.log(`    claude mcp add styleforge node ${serverPath} -e STYLEFORGE_HOME=${dataDir}\n`);
  console.log("  Or add to ~/.claude/settings.json under \"mcpServers\":\n");
  console.log(`    "styleforge": {`);
  console.log(`      "command": "node",`);
  console.log(`      "args": ["${serverPath}"],`);
  console.log(`      "env": { "STYLEFORGE_HOME": "${dataDir}" }`);
  console.log(`    }\n`);
  console.log("  Then restart your MCP client. Try: /style-authors\n");
}

main().catch(() => {});

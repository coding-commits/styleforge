#!/usr/bin/env node
/**
 * styleforge CLI — convenience wrapper.
 *
 * Usage:
 *   styleforge serve         Start the MCP server (stdio mode)
 *   styleforge setup         Re-run postinstall (install commands + print config)
 *   styleforge test          Run smoke tests
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const cmd = process.argv[2] || "help";

switch (cmd) {
  case "serve":
  case "start": {
    const server = path.join(root, "server", "index.js");
    const child = spawn("node", [server], { stdio: "inherit", env: { ...process.env } });
    child.on("exit", (code) => process.exit(code ?? 0));
    break;
  }
  case "setup":
  case "install": {
    const postinstall = path.join(root, "bin", "postinstall.js");
    const child = spawn("node", [postinstall], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    break;
  }
  case "test": {
    const test = path.join(root, "server", "smoke-test.js");
    if (!process.env.STYLEFORGE_HOME) {
      process.env.STYLEFORGE_HOME = "/tmp/styleforge-test";
    }
    const child = spawn("node", [test], { stdio: "inherit", env: { ...process.env } });
    child.on("exit", (code) => process.exit(code ?? 0));
    break;
  }
  default:
    console.log(`
styleforge — per-author writing-style management via MCP

Commands:
  styleforge serve     Start the MCP server (stdio mode)
  styleforge setup     Install slash commands + print MCP config
  styleforge test      Run smoke tests

Install:
  npm install -g styleforge
  styleforge setup
  claude mcp add styleforge node <path-shown-by-setup>
`);
}

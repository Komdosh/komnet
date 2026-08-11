#!/usr/bin/env node
import { runStdioServer } from "./run.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const network = flag("network");
await runStdioServer({
  ...(network === undefined ? {} : { network }),
  ...(process.argv.includes("--direct") ? { direct: true } : {}),
});

#!/usr/bin/env node
import { run } from "./main.ts";

// Exit code is the CLI's contract with agents and scripts:
//   0 success · 1 runtime failure · 2 usage error
process.exitCode = await run(process.argv.slice(2));

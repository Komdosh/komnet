#!/usr/bin/env node
import { run } from "./main.ts";

// `komnet read big-room | head` closes our stdout while we are still writing.
// Without this, Node raises an unhandled EPIPE and prints a stack trace over
// what the user was reading. Piping into a pager or `head` is ordinary usage,
// so exit quietly instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

// Deliberately not top-level `await`: the single-executable build bundles this
// to CommonJS, where top-level await is a syntax error. `.then` works in both
// module systems, so one entry point serves npm and the SEA binary.
//
// Exit code is the CLI's contract with agents and scripts:
//   0 success · 1 runtime failure · 2 usage error
void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

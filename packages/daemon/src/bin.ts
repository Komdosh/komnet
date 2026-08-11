#!/usr/bin/env node
import { Layout } from "@komnet/core";

import { Daemon } from "./daemon.ts";
import type { NotifierKind } from "./notify.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const daemon = new Daemon({
  layout: new Layout(flag("home")),
  notifier: (flag("notify") as NotifierKind | undefined) ?? "os",
  // Under a supervisor there is no terminal, so mirror to stderr and let
  // launchd/systemd capture it alongside the daemon's own log file.
  log: (line) => process.stderr.write(`${line}\n`),
});

const shutdown = (signal: string) => {
  process.stderr.write(`received ${signal}, stopping\n`);
  void daemon.stop().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await daemon.start();
} catch (error) {
  process.stderr.write(`komnetd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

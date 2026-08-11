import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const NOTIFIER_KINDS = ["os", "file", "terminal", "webhook", "none"] as const;
export type NotifierKind = (typeof NOTIFIER_KINDS)[number];

export interface Notification {
  title: string;
  body: string;
  /** `needs: human` and `priority: blocking` — always shown, never batched. */
  urgent?: boolean;
}

export interface Notifier {
  readonly kind: NotifierKind;
  notify(notification: Notification): Promise<void>;
}

/**
 * Make untrusted text safe to hand to a notification backend.
 *
 * Message bodies are written by other machines, and `osascript` interprets its
 * argument as AppleScript source — an unescaped quote would let a message body
 * execute script. Strip the characters that can break out, flatten newlines,
 * and truncate: a notification is a summary, not a transcript.
 */
export function sanitize(text: string, maxLength = 180): string {
  const flattened = text
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/["'\\`$]/g, "")
    .trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

class NoopNotifier implements Notifier {
  readonly kind = "none" as const;
  async notify(): Promise<void> {
    /* recorded in the inbox regardless; this sink only suppresses the popup */
  }
}

class FileNotifier implements Notifier {
  readonly kind = "file" as const;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async notify(notification: Notification): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const mark = notification.urgent === true ? "**" : "";
    await appendFile(
      this.path,
      `- ${new Date().toISOString()} ${mark}${notification.title}${mark} — ${notification.body}\n`,
      "utf8",
    );
  }
}

class TerminalNotifier implements Notifier {
  readonly kind = "terminal" as const;
  async notify(notification: Notification): Promise<void> {
    process.stderr.write(`\n🔔 ${notification.title} — ${notification.body}\n`);
  }
}

/**
 * OS-native notification. Falls back to the file sink rather than failing:
 * a headless box or a locked-down desktop must not turn a missing toast into a
 * crashed daemon.
 */
class OsNotifier implements Notifier {
  readonly kind = "os" as const;
  private readonly fallback: Notifier;

  constructor(fallback: Notifier) {
    this.fallback = fallback;
  }

  async notify(notification: Notification): Promise<void> {
    const title = sanitize(notification.title, 60);
    const body = sanitize(notification.body);
    try {
      if (process.platform === "darwin") {
        await exec("osascript", [
          "-e",
          `display notification "${body}" with title "komnet" subtitle "${title}"`,
        ]);
        return;
      }
      if (process.platform === "linux") {
        await exec("notify-send", [
          "--app-name=komnet",
          `--urgency=${notification.urgent === true ? "critical" : "normal"}`,
          title,
          body,
        ]);
        return;
      }
      await this.fallback.notify(notification);
    } catch {
      await this.fallback.notify(notification);
    }
  }
}

/**
 * POST the notification to a local endpoint.
 *
 * For people wiring komnet into something they already run. Failures fall back
 * to the file sink: an unreachable endpoint must not cost a notification.
 */
class WebhookNotifier implements Notifier {
  readonly kind = "webhook" as const;
  private readonly url: string;
  private readonly fallback: Notifier;

  constructor(url: string, fallback: Notifier) {
    this.url = url;
    this.fallback = fallback;
  }

  async notify(notification: Notification): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`webhook returned ${String(response.status)}`);
    } catch {
      await this.fallback.notify(notification);
    }
  }
}

export function createNotifier(
  kind: NotifierKind,
  noticePath: string,
  options: { webhookUrl?: string } = {},
): Notifier {
  const file = new FileNotifier(noticePath);
  switch (kind) {
    case "os":
      return new OsNotifier(file);
    case "file":
      return file;
    case "terminal":
      return new TerminalNotifier();
    case "webhook":
      return options.webhookUrl === undefined
        ? file
        : new WebhookNotifier(options.webhookUrl, file);
    case "none":
      return new NoopNotifier();
  }
}

/**
 * Decide whether an arriving message should interrupt a human.
 *
 * A noisy tool gets muted, and a muted tool is dead — so the default is silence
 * unless someone is actually blocked (`needs: human`, `blocking`) or personally
 * addressed while no session is open to drain it.
 */
export function shouldNotify(input: {
  needs: string;
  priority: string;
  directlyMentioned: boolean;
  sessionLive: boolean;
}): boolean {
  if (input.needs === "human") return true;
  if (input.priority === "blocking") return true;
  // A live session will drain the inbox on its own; interrupting adds nothing.
  if (input.directlyMentioned && !input.sessionLive) return true;
  return false;
}

/**
 * Pre-send secret scanner (docs/design/08-security-and-trust.md §3).
 *
 * The one check that REFUSES rather than warns. Git history is effectively
 * permanent: a leaked credential cannot be recalled, only rotated. A warning in
 * an agent's output is a warning nobody reads.
 *
 * Invariant enforced throughout this module: **a finding never carries the
 * matched value.** Only the rule name and a line number leave here — otherwise
 * the scanner would itself copy secrets into logs and error messages.
 */

export interface SecretRule {
  name: string;
  pattern: RegExp;
  /** Rough confidence; low-confidence rules are entropy-gated. */
  entropyGated?: boolean;
}

export interface SecretFinding {
  rule: string;
  /** 1-indexed. */
  line: number;
  /** Column of the match start, 1-indexed. Enough to locate without quoting. */
  column: number;
}

export interface ScanOptions {
  extraRules?: readonly SecretRule[];
  /** Minimum Shannon entropy (bits/char) for entropy-gated rules. */
  minEntropy?: number;
}

/**
 * Values that look like credentials but are obviously placeholders. Matching
 * one suppresses the finding — false positives on `<your-token-here>` train
 * people to reach for the override, which is worse than the miss.
 */
const PLACEHOLDER =
  /^(?:x{3,}|\.{3,}|-+|<[^>]*>|\{\{?[^}]*\}?\}|\$\{[^}]*\}|(?:your|my|the)[-_]?\w*|example\w*|sample\w*|dummy\w*|placeholder\w*|redacted\w*|changeme\w*|test{1,2}\w*|foo\w*|bar\w*|abc123\w*|secret|token|password)$/i;

const RULES: readonly SecretRule[] = [
  { name: "private-key-block", pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "connection-string-password",
    // scheme://user:secret@host — the password is in the URL.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi,
  },
  {
    name: "credential-assignment",
    pattern:
      /\b(?:passwd|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
    entropyGated: true,
  },
];

/**
 * Shannon entropy in bits per character.
 *
 * Used only to gate the broad `credential-assignment` rule: `password = hunter2`
 * in prose should not block a send, while `password = 8Jd0aQ2mZk91LpXv` should.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  // A single repeated character carries no secret.
  return new Set(value).size <= 2;
}

/**
 * Scan text for credential-shaped content.
 *
 * Returns findings with rule and position only. Callers may safely log the
 * result in full — by construction it contains no secret material.
 */
export function scanForSecrets(text: string, options: ScanOptions = {}): SecretFinding[] {
  const minEntropy = options.minEntropy ?? 3.2;
  const rules = [...RULES, ...(options.extraRules ?? [])];
  const lines = text.split("\n");
  const findings: SecretFinding[] = [];

  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      // Reset per line: the shared /g regexes carry lastIndex between uses.
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        // Zero-length matches would loop forever.
        if (match[0].length === 0) {
          rule.pattern.lastIndex += 1;
          continue;
        }
        const captured = match[1] ?? match[0];
        if (isPlaceholder(captured)) continue;
        if (rule.entropyGated === true && shannonEntropy(captured) < minEntropy) continue;

        findings.push({ rule: rule.name, line: i + 1, column: match.index + 1 });
        if (!rule.pattern.global) break;
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function hasSecrets(text: string, options?: ScanOptions): boolean {
  return scanForSecrets(text, options).length > 0;
}

/**
 * Render findings for a human or an agent to act on.
 *
 * Deliberately quotes nothing from the source: the point is to say *where* to
 * look, not to reproduce the secret in a second place.
 */
export function describeFindings(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return "no findings";
  return findings
    .map((f) => `${f.rule} at line ${String(f.line)}, column ${String(f.column)}`)
    .join("; ");
}

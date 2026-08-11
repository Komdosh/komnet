/**
 * Wire protocol version.
 *
 * Bump only for changes that a peer running the previous version cannot safely
 * ignore. Adding an optional header field is NOT such a change: readers must
 * preserve unknown fields verbatim (see `docs/adr/0007-forward-compatibility.md`),
 * so additive evolution stays on version 1.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Versions this build can read. A message carrying a version outside this set is
 * surfaced to the operator rather than dropped — silently discarding traffic from
 * a newer peer is how a network splits without anyone noticing.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

export function isSupportedVersion(v: number): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(v);
}

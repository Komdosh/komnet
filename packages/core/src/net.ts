import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const AUTHENTICITY_MODES = ["none", "git", "signed"] as const;
export type AuthenticityMode = (typeof AUTHENTICITY_MODES)[number];

export interface NetManifest {
  v: number;
  id: string;
  name: string;
  protocolVersion: number;
  /** How strongly a message's `from` is checked on receipt (spec §10). */
  authenticity: AuthenticityMode;
}

export const DEFAULT_MANIFEST: Omit<NetManifest, "id" | "name"> = {
  v: 1,
  protocolVersion: 1,
  authenticity: "git",
};

export function serializeNetManifest(manifest: NetManifest): string {
  return stringifyYaml(
    {
      v: manifest.v,
      id: manifest.id,
      name: manifest.name,
      protocol_version: manifest.protocolVersion,
      authenticity: manifest.authenticity,
    },
    { lineWidth: 0 },
  );
}

export function parseNetManifest(raw: string): NetManifest {
  const y = parseYaml(raw) as Record<string, unknown> | null;
  if (y === null || typeof y !== "object") throw new Error("net.yaml is not a YAML mapping");

  const declared = String(y["authenticity"] ?? "git");
  // An unrecognised mode is treated as the strictest one we understand rather
  // than as "none": silently downgrading a security setting because a newer
  // peer wrote a value we do not know is exactly the wrong failure direction.
  const authenticity = (AUTHENTICITY_MODES as readonly string[]).includes(declared)
    ? (declared as AuthenticityMode)
    : "signed";

  return {
    v: Number(y["v"] ?? 1),
    id: String(y["id"] ?? "komnet"),
    name: String(y["name"] ?? y["id"] ?? "komnet"),
    protocolVersion: Number(y["protocol_version"] ?? 1),
    authenticity,
  };
}

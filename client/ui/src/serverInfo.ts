/**
 * What `auth.ok` told us about the server we're connected to. Populated from
 * the `auth.ok` handler (fully wired in SPEC-008). Until then `features` is
 * empty and every version-gated path falls back to its v1 form.
 */
export type ServerInfo = {
  protocolVersion: number;
  serverVersion: string;
  features: Set<string>;
};

let info: ServerInfo = {
  protocolVersion: 1,
  serverVersion: "unknown",
  features: new Set<string>(),
};

export function setServerInfo(next: {
  protocol_version?: number;
  server_version?: string;
  features?: string[];
}) {
  info = {
    protocolVersion: typeof next.protocol_version === "number" ? next.protocol_version : 1,
    serverVersion: typeof next.server_version === "string" ? next.server_version : "unknown",
    features: new Set(Array.isArray(next.features) ? next.features : []),
  };
}

export function serverInfo(): ServerInfo {
  return info;
}

/** Convenience: does the server advertise `feature` in `auth.ok.features`? */
export function hasFeature(feature: string): boolean {
  return info.features.has(feature);
}

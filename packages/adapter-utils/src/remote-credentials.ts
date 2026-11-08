export const REMOTE_CREDENTIAL_MODES = ["managed", "native"] as const;

export type RemoteCredentialMode = (typeof REMOTE_CREDENTIAL_MODES)[number];

/**
 * SSH credential source for adapters that otherwise stage a controller login.
 * Unset and any value other than `native` stay on the managed path.
 */
export function readRemoteCredentialMode(config: object | null | undefined): RemoteCredentialMode {
  if (!config || !("remoteCredentials" in config)) return "managed";
  return (config as { remoteCredentials?: unknown }).remoteCredentials === "native" ? "native" : "managed";
}

/**
 * Native credentials apply only to SSH. Sandbox and local runs keep managed
 * staging, including when an agent saved `remoteCredentials: "native"`.
 */
export function usesNativeSshCredentials(
  config: object | null | undefined,
  target: { kind?: string; transport?: string } | null | undefined,
): boolean {
  return readRemoteCredentialMode(config) === "native"
    && target?.kind === "remote"
    && target.transport === "ssh";
}

/** Agent-configured home path used on the remote host. Not resolved on the controller. */
export function readConfiguredRemoteHome(
  env: object | null | undefined,
  key: string,
): string | null {
  if (!env || !(key in env)) return null;
  const value = (env as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

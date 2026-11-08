import { describe, expect, it } from "vitest";
import {
  readConfiguredRemoteHome,
  readRemoteCredentialMode,
  usesNativeSshCredentials,
} from "./remote-credentials.js";

describe("remote credential mode", () => {
  it("treats unset and unknown values as managed", () => {
    expect(readRemoteCredentialMode(undefined)).toBe("managed");
    expect(readRemoteCredentialMode({})).toBe("managed");
    expect(readRemoteCredentialMode({ remoteCredentials: "managed" })).toBe("managed");
    expect(readRemoteCredentialMode({ remoteCredentials: "elsewhere" })).toBe("managed");
  });

  it("recognizes native", () => {
    expect(readRemoteCredentialMode({ remoteCredentials: "native" })).toBe("native");
  });

  it("enables native credentials only for an SSH target", () => {
    const config = { remoteCredentials: "native" };
    expect(usesNativeSshCredentials(config, { kind: "remote", transport: "ssh" })).toBe(true);
    expect(usesNativeSshCredentials(config, { kind: "remote", transport: "sandbox" })).toBe(false);
    expect(usesNativeSshCredentials(config, { kind: "local" })).toBe(false);
    expect(usesNativeSshCredentials(config, null)).toBe(false);
    expect(usesNativeSshCredentials({}, { kind: "remote", transport: "ssh" })).toBe(false);
  });

  it("reads a trimmed remote home and ignores non-strings", () => {
    expect(readConfiguredRemoteHome({ CODEX_HOME: "  /home/user/.codex  " }, "CODEX_HOME")).toBe("/home/user/.codex");
    expect(readConfiguredRemoteHome({ CODEX_HOME: "   " }, "CODEX_HOME")).toBeNull();
    expect(readConfiguredRemoteHome({ CODEX_HOME: { type: "secret_ref" } }, "CODEX_HOME")).toBeNull();
    expect(readConfiguredRemoteHome(undefined, "GROK_HOME")).toBeNull();
  });
});

import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { SelectPopover } from "../../components/ui/select";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Paperclip stages it into the Grok workspace as Agents.md when possible.";

export function GrokLocalConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, (
    <>
      <Field
        label="SSH remote credentials"
        hint="Managed copies this instance's Grok login to the SSH host for each run and copies a refreshed login back. Native uses the login already on the SSH host. Set GROK_HOME to a path on that host, or leave it unset to use the host default. Sandbox runs stay managed."
      >
        <SelectPopover
          aria-label="SSH remote credentials"
          value={
            isCreate
              ? (values!.remoteCredentials ?? "managed")
              : eff("adapterConfig", "remoteCredentials", String(config.remoteCredentials ?? "managed")) === "native"
                ? "native"
                : "managed"
          }
          onValueChange={(next) => {
            const value = next === "native" ? "native" : "managed";
            isCreate
              ? set!({ remoteCredentials: value })
              : mark("adapterConfig", "remoteCredentials", value === "managed" ? undefined : value);
          }}
          options={[
            { value: "managed", label: "Managed login" },
            { value: "native", label: "Remote host login" },
          ]}
        />
      </Field>
      {!hideInstructionsFile && (
      <Field label="Agent instructions file" hint={instructionsFileHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff(
                    "adapterConfig",
                    "instructionsFilePath",
                    String(config.instructionsFilePath ?? ""),
                  )
            }
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
      )}
    </>
  ));
}

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ExecutionBindingSelection } from "@paperclipai/shared/execution-bindings";
import { executionBindingsApi } from "../api/execution-bindings";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Props {
  companyId: string;
  agentId: string;
  contextKey: string;
  value?: ExecutionBindingSelection | null;
  disabled?: boolean;
  onSelect: (selection: ExecutionBindingSelection | null) => void | Promise<unknown>;
}
export function ExecutionBindingSelector({ companyId, agentId, contextKey, value, disabled, onSelect }: Props) {
  const { data: bindings, isPending, error } = useQuery({
    queryKey: queryKeys.executionBindings.list(companyId),
    queryFn: () => executionBindingsApi.list(companyId),
  });
  const [bindingId, setBindingId] = useState(value?.bindingId ?? "");
  const [dataClass, setDataClass] = useState<"" | ExecutionBindingSelection["dataClass"]>(value?.dataClass ?? "");
  const [capabilities, setCapabilities] = useState(value?.requiredCapabilities.join(", ") ?? "");
  const [reason, setReason] = useState(value?.reason ?? "");
  const [evidence, setEvidence] = useState(value?.evidenceRefs.join("\n") ?? "");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const version = useRef(0);
  const persistence = useRef<Promise<unknown>>(Promise.resolve());
  function persist(selection: ExecutionBindingSelection | null) {
    const next = persistence.current.catch(() => undefined).then(() => onSelect(selection));
    persistence.current = next;
    return next;
  }
  const mounted = useRef(true);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const choices = (bindings ?? []).filter(binding => binding.adapterType === "codex_local" || binding.adapterType === "claude_local");
  const selected = choices.find(binding => binding.id === bindingId);
  const invalidate = () => {
    const editVersion = ++version.current;
    setPending(false);
    setMessage("");
    void persist(null).catch(cause => {
      if (mounted.current && version.current === editVersion) setMessage(cause instanceof Error ? cause.message : "Unable to clear saved qualification.");
    });
  };
  async function qualify() {
    if (!selected || !dataClass || disabled) return;
    const requestVersion = ++version.current;
    const requestContext = contextKey;
    setPending(true);
    setMessage("");
    try {
      await persist(null);
      if (!mounted.current || version.current !== requestVersion || currentContext.current !== requestContext) return;
      const result = await executionBindingsApi.preview(companyId, {
        agentId,
        requirements: {
          model: selected.models[0]!, dataClass,
          requiredCapabilities: capabilities.split(",").map(x => x.trim()).filter(Boolean),
          reason: reason.trim(), evidenceRefs: evidence.split("\n").map(x => x.trim()).filter(Boolean),
          preferredBindingIds: [selected.id],
        },
      });
      if (!mounted.current || version.current !== requestVersion || currentContext.current !== requestContext) return;
      if (result.status === "selected" && result.selection.bindingId === selected.id) {
        await persist(result.selection);
        if (!mounted.current || version.current !== requestVersion || currentContext.current !== requestContext) return;
        setMessage("Qualified. Account capacity is not reserved; remaining quota is unknown.");
      } else {
        const decision = result.candidates.find(candidate => candidate.bindingId === selected.id);
        setMessage(decision?.exclusions.map(x => x.replaceAll("_", " ")).join(", ") || "No qualified selection. Check the required fields and evidence.");
      }
    } catch (cause) {
      if (mounted.current && version.current === requestVersion && currentContext.current === requestContext) setMessage(cause instanceof Error ? cause.message : "Qualification failed.");
    } finally {
      if (mounted.current && version.current === requestVersion) setPending(false);
    }
  }
  return <fieldset disabled={disabled} className="space-y-3 rounded-md border border-border p-3 text-sm">
    <legend className="px-1 font-medium">Task execution</legend>
    <p className="text-xs text-muted-foreground">Use a role authorised for this project. Classification includes instructions, files and workspace contents. Qualification grants no extra permissions.</p>
    {isPending && <p role="status">Loading qualified executions…</p>}
    {error && <p role="alert">Unable to load execution bindings: {error.message}</p>}
    <label className="block space-y-1"><span>Account and exact model</span><select aria-label="Account and exact model" className="w-full rounded-md border border-input bg-background p-2" value={bindingId} onChange={event => { invalidate(); setBindingId(event.target.value); }}>
      <option value="">Select an execution</option>
      {choices.map(binding => <option key={binding.id} value={binding.id}>{binding.name} · {binding.accountKey} · {binding.adapterType === "codex_local" ? "Codex" : "Claude Code"} · {binding.models[0]}{binding.reasoningEffort ? ` · ${binding.reasoningEffort}` : ""}{!binding.allowedAgentIds.includes(agentId) ? " · role not permitted" : ""}{!binding.enabled ? " · disabled" : ""}</option>)}
    </select></label>
    {!isPending && !error && choices.length === 0 && <p>No qualified Codex or Claude executions are configured. Ask the operator to qualify a route.</p>}
    {selected && <p className="text-xs text-muted-foreground">Evidence expires {selected.verifiedUntil}. Qualified capabilities: {selected.capabilities.join(", ")}. References: {selected.evidenceRefs.join(", ")}</p>}
    <label className="block space-y-1"><span>Task data class</span><select aria-label="Task data class" className="w-full rounded-md border border-input bg-background p-2" value={dataClass} onChange={event => { invalidate(); setDataClass(event.target.value as typeof dataClass); }}><option value="">Classify all task inputs</option><option value="public">Public</option><option value="synthetic">Synthetic</option><option value="private">Private</option></select></label>
    <label className="block space-y-1"><span>Required capabilities, separated by commas</span><Input value={capabilities} onChange={event => { invalidate(); setCapabilities(event.target.value); }} /></label>
    <label className="block space-y-1"><span>Why this execution is appropriate</span><Input value={reason} onChange={event => { invalidate(); setReason(event.target.value); }} /></label>
    <label className="block space-y-1"><span>Task evidence references, one per line</span><textarea className="w-full rounded-md border border-input bg-background p-2" value={evidence} onChange={event => { invalidate(); setEvidence(event.target.value); }} /></label>
    <Button type="button" variant="outline" disabled={disabled || pending || !selected || !dataClass || !capabilities.trim() || !reason.trim() || !evidence.trim()} onClick={() => void qualify()}>{pending ? "Checking…" : "Qualify selection"}</Button>
    {message && <p role="status">{message}</p>}
    {disabled && <p className="text-xs text-muted-foreground">Choose a local project workspace and finish any active run before changing execution.</p>}
  </fieldset>;
}

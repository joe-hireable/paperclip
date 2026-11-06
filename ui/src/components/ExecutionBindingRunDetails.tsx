import type { HeartbeatRun } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { executionBindingsApi } from "../api/execution-bindings";
import { formatDateTime } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { queryOptions } from "@tanstack/react-query";

type RunBinding = Awaited<ReturnType<typeof executionBindingsApi.forRun>>;

export function executionBindingPollInterval(record: RunBinding | undefined, status: HeartbeatRun["status"]) {
  return status === "running" || status === "queued" || record === undefined || record?.releasedAt === null
    ? 3000 : false;
}

export function executionBindingQueryOptions(companyId: string, runId: string, status: HeartbeatRun["status"]) {
  return queryOptions({
    queryKey: [...queryKeys.executionBindings.forRun(companyId, runId), status],
    queryFn: () => executionBindingsApi.forRun(companyId, runId),
    retry: false,
    refetchInterval: (query) => executionBindingPollInterval(query.state.data, status),
  });
}

// All three run restart controls must recheck the durable record before waking.
export async function assertUnboundRunRestart(companyId: string, runId: string) {
  if (await executionBindingsApi.forRun(companyId, runId)) {
    throw new Error("This execution binding requires a fresh task attempt. Review its result and account reservation first.");
  }
}

interface ExecutionBindingRunDetailsProps {
  record: RunBinding | undefined;
  runStatus: HeartbeatRun["status"];
  taskId?: string | null;
  loading: boolean;
  failed: boolean;
}

export function ExecutionBindingRunDetails({ record, runStatus, taskId, loading, failed }: ExecutionBindingRunDetailsProps) {
  if (failed) return <p role="alert" className="text-sm text-destructive">Could not verify the account reservation. Reload before attempting another run.</p>;
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Checking account reservation…</p>;
  if (!record) return null;

  const { binding, selection, resolvedAt } = record.snapshot;
  const terminal = runStatus !== "running" && runStatus !== "queued";
  const reserved = record.releasedAt === null;
  return (
    <section aria-label="Execution binding" className="space-y-3 border border-border rounded-lg p-4 text-sm">
      <h3 className="font-medium">Execution binding</h3>
      <p role="status">
        {reserved ? (terminal ? "Execution finished; account still reserved" : "Account reserved for this execution") : "Account reservation released"}
      </p>
      {reserved && terminal && <p className="text-muted-foreground">Process cleanup or reconciliation is still required. This account remains unavailable for another bound run.</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><dt className="text-muted-foreground">Route</dt><dd className="break-words">{binding.name}</dd></div>
        <div><dt className="text-muted-foreground">Harness / account</dt><dd className="font-mono break-words">{binding.adapterType} / {binding.accountKey}</dd></div>
        <div><dt className="text-muted-foreground">Selected model</dt><dd className="font-mono break-words">{selection.model}</dd></div>
        <div><dt className="text-muted-foreground">Served model</dt><dd>Not independently verified</dd></div>
        {binding.reasoningEffort && <div><dt className="text-muted-foreground">Qualified effort</dt><dd>{binding.reasoningEffort}</dd></div>}
        <div><dt className="text-muted-foreground">Input classification</dt><dd>{selection.dataClass}</dd></div>
        <div><dt className="text-muted-foreground">Resolved</dt><dd>{formatDateTime(resolvedAt)}</dd></div>
        <div><dt className="text-muted-foreground">Selection reason</dt><dd className="break-words">{selection.reason}</dd></div>
        {record.releasedAt && <div><dt className="text-muted-foreground">Released</dt><dd>{formatDateTime(record.releasedAt)}</dd></div>}
        {record.releaseReason && <div><dt className="text-muted-foreground">Release evidence</dt><dd className="font-mono break-words">{record.releaseReason}</dd></div>}
      </dl>
      <div className="space-y-1">
        <h4 className="font-medium">Evidence references</h4>
        <ul className="list-disc pl-4 space-y-1">
          {Array.from(new Set([...selection.evidenceRefs, ...binding.evidenceRefs])).map((ref) => <li key={ref} className="break-words">{ref}</li>)}
        </ul>
      </div>
      <p className="text-muted-foreground">Retrying or resuming this native session is not supported. Review the result and prepare a fresh task attempt.</p>
      {taskId && <Link to={`/issues/${taskId}`} className="underline underline-offset-2">Open task and work products</Link>}
    </section>
  );
}

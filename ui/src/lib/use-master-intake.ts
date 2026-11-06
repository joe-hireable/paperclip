import { useEffect, useRef, useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { addIssueCommentSchema } from "@paperclipai/shared";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { issuesApi, type CoordinatorIntakeComment } from "../api/issues";
import { loadStructuredDraft, saveStructuredDraft } from "./composer-draft";
import { upsertIssueCommentInPages } from "./optimistic-issue-comments";
import { queryKeys } from "./queryKeys";

export interface MasterIntakeTarget {
  companyId: string;
  masterIssueId: string;
  authorUserId: string;
}
interface PendingIntake extends MasterIntakeTarget {
  version: 1;
  requestId: string;
  body: string;
}
/** The exact submitted body is retained separately; composers must not merge it into a next draft. */
export class PendingIntakeError extends Error {}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function storageKey(target: MasterIntakeTarget) {
  return `paperclip:master-intake:${JSON.stringify([target.authorUserId, target.companyId, target.masterIssueId])}`;
}
function pendingSlotLocks() {
  if (!navigator.locks?.request)
    throw new Error(
      "Web Locks are unavailable. Keep the draft and use a browser with secure storage coordination before sending.",
    );
  return navigator.locks;
}
function withPendingSlotLock<T>(key: string, action: () => T) {
  // Only synchronous storage mutations belong here; never hold the lock across a request.
  return pendingSlotLocks().request(key, { mode: "exclusive" }, action);
}
function readPending(target: MasterIntakeTarget): PendingIntake | null {
  const key = storageKey(target);
  if (localStorage.getItem(key) === null) return null;
  const value = loadStructuredDraft<PendingIntake | null>(key, null);
  if (
    !value ||
    value.version !== 1 ||
    value.companyId !== target.companyId ||
    value.masterIssueId !== target.masterIssueId ||
    value.authorUserId !== target.authorUserId ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    !uuid.test(value.requestId)
  ) {
    throw new Error(
      "The saved pending message could not be read. Keep this browser's data and ask for recovery. No new message was sent.",
    );
  }
  return value;
}
function matchesChild(child: Issue, input: PendingIntake) {
  return (
    child.companyId === input.companyId &&
    child.parentId === input.masterIssueId &&
    child.originId === input.masterIssueId &&
    child.originKind === "project_coordinator_intake" &&
    child.originFingerprint === input.requestId &&
    ["blocked", "cancelled"].includes(child.status)
  );
}
interface State {
  key: string | null;
  pending: PendingIntake | null;
  error: string | null;
  receipt: Issue | null;
  busy: boolean;
}
function initial(target: MasterIntakeTarget | null): State {
  const base = {
    key: target ? storageKey(target) : null,
    pending: null,
    error: null,
    receipt: null,
    busy: false,
  };
  try {
    return { ...base, pending: target ? readPending(target) : null };
  } catch (error) {
    return {
      ...base,
      error:
        error instanceof Error
          ? error.message
          : "Pending message storage is unavailable.",
    };
  }
}

/** One explicit submission per master, not an automatic retry queue. */
export function useMasterIntake(target: MasterIntakeTarget | null) {
  const queryClient = useQueryClient();
  const key = target ? storageKey(target) : null;
  const [state, setState] = useState<State>(() => initial(target));
  if (state.key !== key) setState(initial(target));
  const activeKey = useRef(key);
  activeKey.current = key;
  const mounted = useRef(true);
  const inFlight = useRef(new Set<string>());
  const companyId = target?.companyId;
  const masterIssueId = target?.masterIssueId;
  const authorUserId = target?.authorUserId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!key || !companyId || !masterIssueId || !authorUserId) return;
    const capturedTarget = { companyId, masterIssueId, authorUserId };
    const refresh = () => {
      const stored = initial(capturedTarget);
      setState((current) =>
        current.key === key
          ? {
              ...current,
              pending: stored.pending,
              error: stored.error,
              receipt: stored.pending ? null : current.receipt,
            }
          : current,
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === key || event.key === null)
      )
        refresh();
    };
    window.addEventListener("storage", onStorage);
    refresh(); // Cover a write between the initial render and listener installation.
    return () => window.removeEventListener("storage", onStorage);
  }, [key, companyId, masterIssueId, authorUserId]);
  function update(capturedKey: string, change: Partial<State>) {
    if (mounted.current && activeKey.current === capturedKey)
      setState((current) =>
        current.key === capturedKey ? { ...current, ...change } : current,
      );
  }
  async function complete(
    input: PendingIntake,
    child: Issue,
    comment?: CoordinatorIntakeComment,
  ) {
    const capturedKey = storageKey(input);
    // A late response must not remove a different submission written by another page/tab.
    await withPendingSlotLock(capturedKey, () => {
      const stored = readPending(input);
      if (stored?.requestId !== input.requestId || stored.body !== input.body)
        throw new Error(
          "Pending message changed; the saved receipt needs recovery.",
        );
      localStorage.removeItem(capturedKey);
      if (localStorage.getItem(capturedKey) !== null)
        throw new Error(
          "Receipt confirmed, but pending storage could not be cleared. Retry verification before sending again.",
        );
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.issues.comments(input.masterIssueId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.issues.listByDescendantRoot(
        input.companyId,
        input.masterIssueId,
      ),
    });
    queryClient.setQueryData(queryKeys.issues.detail(child.id), child);
    if (comment) {
      queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
        queryKeys.issues.comments(input.masterIssueId),
        (current) =>
          current
            ? {
                ...current,
                pages: upsertIssueCommentInPages(current.pages, comment),
              }
            : {
                pageParams: [null],
                pages: upsertIssueCommentInPages(undefined, comment),
              },
      );
    }
    update(capturedKey, { pending: null, receipt: child, error: null });
  }
  async function deliver(input: PendingIntake) {
    const capturedKey = storageKey(input);
    if (inFlight.current.has(capturedKey))
      throw new PendingIntakeError("This message is already being saved.");
    inFlight.current.add(capturedKey);
    update(capturedKey, { busy: true, error: null });
    try {
      pendingSlotLocks();
      const result = await issuesApi.addCoordinatorIntake(input.masterIssueId, {
        requestId: input.requestId,
        body: input.body,
      });
      if (
        result.intakeRequestId !== input.requestId ||
        result.issueId !== input.masterIssueId ||
        result.companyId !== input.companyId ||
        result.authorUserId !== input.authorUserId ||
        !result.coordinatorIntake ||
        !matchesChild(result.coordinatorIntake, input)
      ) {
        throw new Error(
          "The response did not confirm this message's intake identity.",
        );
      }
      await complete(input, result.coordinatorIntake, result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Saving was not confirmed.";
      update(capturedKey, {
        error: `${message} The original message is kept below. Retry it unchanged, or check its saved receipt. No agent work has been started.`,
      });
      throw new PendingIntakeError(message);
    } finally {
      inFlight.current.delete(capturedKey);
      update(capturedKey, { busy: false });
    }
  }
  async function send(body: string) {
    if (!target)
      throw new Error("A signed-in project conversation is required.");
    const capturedKey = storageKey(target);
    try {
      const input = await withPendingSlotLock(capturedKey, () => {
        if (readPending(target))
          throw new Error(
            "Resolve the pending message before sending another one.",
          );
        const input: PendingIntake = {
          ...target,
          version: 1,
          requestId: crypto.randomUUID(),
          body,
        };
        saveStructuredDraft(capturedKey, input);
        if (JSON.stringify(readPending(target)) !== JSON.stringify(input))
          throw new Error(
            "Unable to store this message safely. Keep the draft and make browser storage available before sending.",
          );
        return input;
      });
      update(capturedKey, { pending: input, receipt: null });
      await deliver(input);
    } catch (error) {
      if (!(error instanceof PendingIntakeError))
        update(capturedKey, {
          error:
            error instanceof Error
              ? error.message
              : "Message storage is unavailable.",
        });
      throw error;
    }
  }

  async function retry() {
    if (!target) return;
    try {
      const input = readPending(target);
      if (input) await deliver(input);
    } catch (error) {
      if (!(error instanceof PendingIntakeError))
        update(storageKey(target), {
          error: error instanceof Error ? error.message : "Retry unavailable.",
        });
    }
  }
  async function checkSaved() {
    if (!target) return;
    const capturedKey = storageKey(target);
    if (inFlight.current.has(capturedKey)) return;
    inFlight.current.add(capturedKey);
    update(capturedKey, { busy: true, error: null });
    try {
      const input = readPending(target);
      if (!input) return;
      // Bounded read-only lookup; an incomplete scan never proves that input was not saved.
      for (let offset = 0; offset < 2000; offset += 100) {
        const children = await issuesApi.list(input.companyId, {
          originKind: "project_coordinator_intake",
          originId: input.masterIssueId,
          limit: 100,
          offset,
        });
        const child = children.find((candidate) =>
          matchesChild(candidate, input),
        );
        if (child) {
          const document = await issuesApi.getDocument(
            child.id,
            "coordinator-intake-source",
          );
          const source = JSON.parse(document.body);
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({
                body: addIssueCommentSchema.parse({ body: input.body }).body,
                userId: input.authorUserId,
              }),
            ),
          );
          const expected = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (
            source.version !== 1 ||
            source.companyId !== input.companyId ||
            source.masterIssueId !== input.masterIssueId ||
            source.requestId !== input.requestId ||
            source.requestedByUserId !== input.authorUserId ||
            source.requestDigest !== expected
          ) {
            throw new Error(
              "The source document did not confirm this exact pending message.",
            );
          }
          await complete(input, child);
          return;
        }
        if (children.length < 100) break;
      }
      throw new Error(
        "Saved receipt not confirmed. Keep this pending message; an archived project may require an authorised owner to inspect its intake records.",
      );
    } catch (error) {
      update(capturedKey, {
        error:
          error instanceof Error
            ? error.message
            : "Saved receipt not confirmed.",
      });
    } finally {
      inFlight.current.delete(capturedKey);
      update(capturedKey, { busy: false });
    }
  }
  return { ...state, send, retry, checkSaved };
}

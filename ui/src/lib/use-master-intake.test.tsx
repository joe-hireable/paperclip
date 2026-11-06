import { webcrypto, createHash } from "node:crypto";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMasterIntake, type MasterIntakeTarget } from "./use-master-intake";
const api = vi.hoisted(() => ({
  addCoordinatorIntake: vi.fn(),
  list: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock("../api/issues", () => ({ issuesApi: api }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target: MasterIntakeTarget = {
  companyId: "company-a",
  masterIssueId: "master-a",
  authorUserId: "user-a",
};
let current: ReturnType<typeof useMasterIntake>;
let root: Root, container: HTMLDivElement, client: QueryClient;
function Harness({ value }: { value: MasterIntakeTarget | null }) {
  current = useMasterIntake(value);
  return (
    <div>
      {current.error}
      {current.receipt?.identifier}
    </div>
  );
}
async function render(value: MasterIntakeTarget | null = target) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness value={value} />
      </QueryClientProvider>,
    );
  });
}
function receipt(input: { requestId: string; body: string }, t = target) {
  return {
    id: "comment-a",
    issueId: t.masterIssueId,
    companyId: t.companyId,
    body: input.body,
    authorUserId: t.authorUserId,
    intakeRequestId: input.requestId,
    coordinatorIntake: {
      id: "child-a",
      identifier: "PAP-99",
      companyId: t.companyId,
      parentId: t.masterIssueId,
      originId: t.masterIssueId,
      originKind: "project_coordinator_intake",
      originFingerprint: input.requestId,
      status: "blocked",
    },
  };
}
// Deterministic model of native per-name exclusive Web Locks across two hook instances.
// Storage interception below represents another tab running between localStorage operations.
function installWebLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const request = vi.fn(
    (name: string, _options: unknown, callback: () => unknown) =>
      new Promise((resolve, reject) => {
        const run = () => {
          held.add(name);
          let result: unknown;
          try {
            result = callback();
          } catch (error) {
            result = Promise.reject(error);
          }
          const release = () => {
            held.delete(name);
            const next = queues.get(name)?.shift();
            if (next) next();
          };
          Promise.resolve(result).then(
            (value) => {
              release();
              resolve(value);
            },
            (error) => {
              release();
              reject(error);
            },
          );
        };
        if (held.has(name)) {
          const queue = queues.get(name) ?? [];
          queue.push(run);
          queues.set(name, queue);
        } else run();
      }),
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });
  return request;
}
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  installWebLocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});
it("persists exact input before dispatch and retries an ambiguous send after remount", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) => {
    expect(localStorage.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).body).toBe(
      input.body,
    );
    throw new Error("response lost");
  });
  await render();
  await act(async () => {
    await expect(current.send("Original\n\n[file](/asset)")).rejects.toThrow();
  });
  const envelope = current.pending!;
  expect(envelope.body).toBe("Original\n\n[file](/asset)");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(current.pending).toEqual(envelope);
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
  api.addCoordinatorIntake.mockImplementation(async (_id, input) =>
    receipt(input),
  );
  await act(async () => {
    await current.retry();
  });
  expect(api.addCoordinatorIntake.mock.calls[1]).toEqual([
    target.masterIssueId,
    { requestId: envelope.requestId, body: envelope.body },
  ]);
  expect(current.pending).toBeNull();
  expect(current.receipt?.identifier).toBe("PAP-99");
  expect(localStorage.length).toBe(0);
});
it("refuses changed/new body while an ambiguous envelope remains", async () => {
  api.addCoordinatorIntake.mockRejectedValue(new Error("network"));
  await render();
  await act(async () => {
    await expect(current.send("first")).rejects.toThrow();
  });
  const id = current.pending!.requestId;
  await act(async () => {
    await expect(current.send("edited")).rejects.toThrow();
  });
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
  expect(current.pending!.requestId).toBe(id);
  expect(current.pending!.body).toBe("first");
});
it("does not apply late success to another company/user/master or clear its pending input", async () => {
  let finish!: (value: unknown) => void;
  api.addCoordinatorIntake.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  let first!: Promise<void>;
  await act(async () => {
    first = current.send("first");
  });
  const envelope = current.pending!;
  const other = {
    companyId: "company-b",
    masterIssueId: "master-b",
    authorUserId: "user-b",
  };
  await render(other);
  api.addCoordinatorIntake.mockRejectedValue(new Error("other response lost"));
  await act(async () => {
    await expect(current.send("second")).rejects.toThrow();
  });
  const second = current.pending;
  await act(async () => {
    finish(receipt(envelope));
    await first;
  });
  expect(current.pending).toEqual(second);
  expect(current.receipt).toBeNull();
  expect(container.textContent).not.toContain("PAP-99");
  await render(target);
  expect(current.pending).toBeNull();
});
it("stops before POST if pending storage cannot be persisted", async () => {
  await render();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await act(async () => {
    await expect(current.send("keep this draft")).rejects.toThrow("store");
  });
  expect(api.addCoordinatorIntake).not.toHaveBeenCalled();
});
it("retains pending input when returned identity is wrong or a retry conflicts", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) => ({
    ...receipt(input),
    intakeRequestId: "wrong",
  }));
  await render();
  await act(async () => {
    await expect(current.send("first")).rejects.toThrow();
  });
  const envelope = current.pending;
  api.addCoordinatorIntake.mockRejectedValue(
    new Error("Cannot create coordinator intake in an archived project"),
  );
  await act(async () => {
    await current.retry();
  });
  expect(current.pending).toEqual(envelope);
  expect(current.error).toContain("archived");
});
it("keeps an unconfirmed archived receipt pending after a read-only lookup", async () => {
  api.addCoordinatorIntake.mockRejectedValue(new Error("archived"));
  api.list.mockResolvedValue([]);
  await render();
  await act(async () => {
    await expect(current.send("saved perhaps")).rejects.toThrow();
  });
  const envelope = current.pending;
  await act(async () => {
    await current.checkSaved();
  });
  expect(current.pending).toEqual(envelope);
  expect(current.error).toContain("not confirmed");
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
});

it("confirms an already saved archived input using only native child and source reads", async () => {
  vi.stubGlobal("crypto", webcrypto);
  api.addCoordinatorIntake.mockRejectedValue(new Error("archived"));
  await render();
  await act(async () => {
    await expect(current.send("original\\nbody")).rejects.toThrow();
  });
  const input = current.pending!;
  api.list.mockResolvedValue([receipt(input).coordinatorIntake]);
  api.getDocument.mockResolvedValue({
    body: JSON.stringify({
      version: 1,
      companyId: input.companyId,
      masterIssueId: input.masterIssueId,
      requestId: input.requestId,
      requestedByUserId: input.authorUserId,
      requestDigest: createHash("sha256")
        .update(
          JSON.stringify({
            body: "original\nbody",
            userId: input.authorUserId,
          }),
        )
        .digest("hex"),
    }),
  });
  await act(async () => {
    await current.checkSaved();
  });
  expect(current.pending).toBeNull();
  expect(current.receipt?.identifier).toBe("PAP-99");
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
  expect(api.getDocument).toHaveBeenCalledWith(
    "child-a",
    "coordinator-intake-source",
  );
  vi.unstubAllGlobals();
});
it("does not accept a saved source belonging to another body or author", async () => {
  vi.stubGlobal("crypto", webcrypto);
  api.addCoordinatorIntake.mockRejectedValue(new Error("archived"));
  await render();
  await act(async () => {
    await expect(current.send("original body")).rejects.toThrow();
  });
  const input = current.pending!;
  api.list.mockResolvedValue([receipt(input).coordinatorIntake]);
  api.getDocument.mockResolvedValue({
    body: JSON.stringify({
      version: 1,
      companyId: input.companyId,
      masterIssueId: input.masterIssueId,
      requestId: input.requestId,
      requestedByUserId: "someone else",
      requestDigest: "wrong",
    }),
  });
  await act(async () => {
    await current.checkSaved();
  });
  expect(current.pending).toEqual(input);
  expect(current.receipt).toBeNull();
  vi.unstubAllGlobals();
});
it("refuses corrupt persisted state rather than replacing its request identity", async () => {
  await render();
  api.addCoordinatorIntake.mockRejectedValue(new Error("network"));
  await act(async () => {
    await expect(current.send("first")).rejects.toThrow();
  });
  localStorage.setItem(localStorage.key(0)!, "{broken");
  await render(null);
  await render();
  expect(current.error).toContain("could not be read");
  await act(async () => {
    await expect(current.send("replacement")).rejects.toThrow();
  });
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
});
it("allocates a fresh identity only after confirmed completion", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) =>
    receipt(input),
  );
  await render();
  await act(async () => {
    await current.send("same text");
  });
  await act(async () => {
    await current.send("same text");
  });
  expect(api.addCoordinatorIntake.mock.calls[0][1].requestId).not.toBe(
    api.addCoordinatorIntake.mock.calls[1][1].requestId,
  );
});

it("serialises two tabs that both observe an initially empty pending slot", async () => {
  await render();
  let other!: ReturnType<typeof useMasterIntake>;
  function OtherTab() {
    other = useMasterIntake(target);
    return null;
  }
  const secondContainer = document.createElement("div");
  const secondRoot = createRoot(secondContainer);
  await act(async () =>
    secondRoot.render(
      <QueryClientProvider client={client}>
        <OtherTab />
      </QueryClientProvider>,
    ),
  );
  api.addCoordinatorIntake.mockRejectedValue(new Error("response lost"));
  const get = Storage.prototype.getItem;
  let armed = true;
  let second: Promise<unknown> | undefined;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    const snapshot = get.call(this, key);
    if (
      armed &&
      key.startsWith("paperclip:master-intake:") &&
      snapshot === null
    ) {
      armed = false;
      second = other.send("other tab").catch((error) => error);
    }
    return snapshot;
  });
  try {
    await act(async () => {
      await current.send("first tab").catch((error) => error);
      await second;
    });
    expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(stored.body).toBe(api.addCoordinatorIntake.mock.calls[0][1].body);
  } finally {
    await act(async () => secondRoot.unmount());
  }
});
it("does not remove a newer tab's envelope between comparison and removal", async () => {
  await render();
  let finish!: (value: unknown) => void;
  api.addCoordinatorIntake.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let sending!: Promise<void>;
  await act(async () => {
    sending = current.send("original");
  });
  const input = current.pending!,
    key = localStorage.key(0)!;
  const newer = {
    ...input,
    requestId: "11111111-1111-4111-8111-111111111111",
    body: "newer tab",
  };
  const get = Storage.prototype.getItem,
    set = Storage.prototype.setItem;
  let reads = 0;
  let write: Promise<unknown> | undefined;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    requestedKey,
  ) {
    const snapshot = get.call(this, requestedKey);
    if (requestedKey === key && ++reads === 2) {
      write = navigator.locks.request(key, { mode: "exclusive" }, () => {
        set.call(localStorage, key, JSON.stringify(newer));
      });
    }
    return snapshot;
  });
  await act(async () => {
    finish(receipt(input));
    await sending.catch((error) => error);
    await write;
  });
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer);
});
it("retains the pending envelope when the response author does not match", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) => ({
    ...receipt(input),
    authorUserId: "another-user",
  }));
  await render();
  await act(async () => {
    await current.send("original").catch((error) => error);
  });
  expect(current.pending?.body).toBe("original");
  expect(current.receipt).toBeNull();
  expect(localStorage.length).toBe(1);
});
it("preserves the draft and sends nothing when native Web Locks are unavailable", async () => {
  Reflect.deleteProperty(navigator, "locks");
  await render();
  await act(async () => {
    await expect(current.send("keep the draft")).rejects.toThrow("Web Locks");
  });
  expect(api.addCoordinatorIntake).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it("synchronises another tab's pending creation and clear without automatic sends", async () => {
  await render();
  let other!: ReturnType<typeof useMasterIntake>;
  function OtherTab() {
    other = useMasterIntake(target);
    return null;
  }
  const otherRoot = createRoot(document.createElement("div"));
  await act(async () =>
    otherRoot.render(
      <QueryClientProvider client={client}>
        <OtherTab />
      </QueryClientProvider>,
    ),
  );
  const storageEvent = (key: string | null) =>
    window.dispatchEvent(
      new StorageEvent("storage", { key, storageArea: localStorage }),
    );
  try {
    api.addCoordinatorIntake.mockRejectedValue(new Error("response lost"));
    await act(async () => {
      await other.send("from another tab").catch(() => {});
    });
    const key = localStorage.key(0)!;
    expect(current.pending).toBeNull();
    await act(async () => {
      storageEvent("unrelated-key");
    });
    expect(current.pending).toBeNull();
    await act(async () => {
      storageEvent(key);
    });
    expect(current.pending).toEqual(other.pending);
    expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
    await act(async () => {
      await current.retry();
    });
    expect(current.error).toContain("response lost");
    api.addCoordinatorIntake.mockImplementation(async (_id, input) =>
      receipt(input),
    );
    await act(async () => {
      await other.retry();
      storageEvent(key);
    });
    expect(current.pending).toBeNull();
    expect(current.error).toBeNull();
    expect(current.receipt).toBeNull(); // An event alone is not a verified receipt.
    expect(other.receipt?.identifier).toBe("PAP-99");
    expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(3);
    api.addCoordinatorIntake.mockRejectedValue(new Error("response lost"));
    await act(async () => {
      await other.send("second input").catch(() => {});
      storageEvent(key);
    });
    expect(current.pending?.body).toBe("second input");
    await act(async () => {
      localStorage.clear();
      storageEvent(null);
    });
    expect(current.pending).toBeNull();
    expect(current.error).toBeNull();
    expect(current.receipt).toBeNull();
    expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => otherRoot.unmount());
  }
});
it("preserves the draft without dispatch when acquiring the storage lock fails", async () => {
  vi.mocked(navigator.locks.request).mockRejectedValue(
    new Error("lock denied"),
  );
  await render();
  await act(async () => {
    await expect(current.send("keep this draft")).rejects.toThrow(
      "lock denied",
    );
  });
  expect(api.addCoordinatorIntake).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it("does not hold the storage lock during a network request", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) => {
    const key = localStorage.key(0)!;
    await navigator.locks.request(key, { mode: "exclusive" }, () => {
      expect(JSON.parse(localStorage.getItem(key)!).requestId).toBe(
        input.requestId,
      );
    });
    return receipt(input);
  });
  await render();
  await act(async () => {
    await current.send("original");
  });
  expect(current.receipt?.identifier).toBe("PAP-99");
  expect(localStorage.length).toBe(0);
});
it("retains confirmed input when the completion lock fails and refuses retry without lock support", async () => {
  api.addCoordinatorIntake.mockImplementation(async (_id, input) => {
    vi.mocked(navigator.locks.request).mockRejectedValueOnce(
      new Error("completion lock denied"),
    );
    return receipt(input);
  });
  await render();
  await act(async () => {
    await expect(current.send("original")).rejects.toThrow(
      "completion lock denied",
    );
  });
  const original = current.pending;
  expect(original?.body).toBe("original");
  expect(current.receipt).toBeNull();
  Reflect.deleteProperty(navigator, "locks");
  await act(async () => {
    await current.retry();
  });
  expect(api.addCoordinatorIntake).toHaveBeenCalledTimes(1);
  expect(current.pending).toEqual(original);
  expect(localStorage.length).toBe(1);
  expect(current.error).toContain("Web Locks");
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  localLearningSha256 as sha,
  normalisedLearningInputSha256,
  openLocalLearningCorpus,
  type LocalLearningCorpusConfig,
  type LocalLearningExample,
} from "./local-learning-corpus.js";

type Corpus = ReturnType<typeof openLocalLearningCorpus>;
const importerId = "trusted-local-importer";
function example(suffix = "one"): LocalLearningExample {
  const input = `Owned synthetic arithmetic fixture ${suffix}: 1 + 1`;
  const output = "2";
  return {
    taskId: `task-${suffix}`,
    taskLineageId: `lineage-${suffix}`,
    taskClass: "arithmetic",
    sources: [
      {
        id: `source-${suffix}`,
        lineageId: `source-lineage-${suffix}`,
        kind: "synthetic_owned",
        sha256: sha(input),
      },
    ],
    route: {
      profileId: "frontier-profile",
      profileSha256: sha("exact attested route"),
      requestedModelId: "frontier-model[1m]",
      expectedServedModelId: "frontier-model",
      servedModelId: "frontier-model",
      effort: "high",
      harness: "synthetic-harness",
      harnessVersion: "1.0",
      accountRef: "synthetic-account",
      runtimeId: "runtime-1",
      actorId: "producer",
      runId: `production-${suffix}`,
    },
    input,
    output,
    inputSha256: sha(input),
    outputSha256: sha(output),
    verification: {
      actorId: "verifier",
      runId: `verification-${suffix}`,
      method: "test_run",
      verdict: "pass",
      subjectTaskId: `task-${suffix}`,
      subjectInputSha256: sha(input),
      subjectOutputSha256: sha(output),
      subjectRouteProfileSha256: sha("exact attested route"),
      evidenceSha256: sha("external test evidence"),
    },
    frontierReview: {
      actorId: "reviewer",
      runId: `review-${suffix}`,
      modelId: "frontier-review-model",
      frontier: true,
      verdict: "pass",
      subjectTaskId: `task-${suffix}`,
      subjectInputSha256: sha(input),
      subjectOutputSha256: sha(output),
      subjectRouteProfileSha256: sha("exact attested route"),
      evidenceSha256: sha("independent frontier review"),
    },
  };
}
let temporary: string;
let config: LocalLearningCorpusConfig;
let corpus: Corpus;
const opened: Corpus[] = [];
function open(overrides: Partial<LocalLearningCorpusConfig> = {}) {
  const value = openLocalLearningCorpus({ ...config, ...overrides });
  opened.push(value);
  return value;
}
function record(
  value = example(),
  disposition: "accepted" | "failed" | "quarantined" = "accepted",
) {
  return corpus.record({
    importerId,
    example: value,
    disposition,
    ...(disposition !== "accepted" ? { reasonCode: "test_failure" } : {}),
  });
}
function admittedTrain() {
  for (let i = 0; i < 40; i += 1) {
    const value = example(`training-${i}`);
    const result = record(value);
    if (result.trainingEligible) return { value, result };
  }
  throw new Error("Expected a train partition in deterministic fixtures");
}
beforeEach(() => {
  temporary = mkdtempSync(path.join(homedir(), ".paperclip-corpus-test-"));
  config = {
    privateRoot: path.join(temporary, "private"),
    excludedRoots: [path.join(temporary, "workspace")],
    companyId: "synthetic-company",
    importerId,
    attestation: {
      id: "own-local-data",
      attestedBy: "operator",
      attestedAt: "2026-09-07T00:00:00.000Z",
      ownData: true,
      localUseOnly: true,
      storageOutsideWorkspacesAndSync: true,
    },
    allowedSourceKinds: ["synthetic_owned"],
  };
  corpus = open();
});
afterEach(() => {
  for (const value of opened.splice(0)) value.close();
  rmSync(temporary, { recursive: true, force: true });
});

describe("local successful-work corpus admission", () => {
  it("persists admitted work and exact requested/served route provenance across reopen", () => {
    const value = example();
    const result = record(value);
    expect(result.disposition).toBe("accepted");
    expect(result.route.requestedModelId).not.toBe(result.route.servedModelId);
    expect(result.route.servedModelId).toBe(value.route.expectedServedModelId);
    corpus.close();
    corpus = open();
    expect(corpus.listMetadata()).toEqual([result]);
    expect(corpus.listMetadata()[0]).not.toHaveProperty("input");
    expect(lstatSync(config.privateRoot).mode & 0o777).toBe(0o700);
    expect(
      lstatSync(path.join(config.privateRoot, "ledger.json")).mode & 0o777,
    ).toBe(0o600);
  });
  it("requires independent verification and frontier review, not a model success claim", () => {
    const value = example();
    delete value.verification;
    delete value.frontierReview;
    const result = record(value);
    expect(result.disposition).toBe("quarantined");
    expect(result.admissionReasons).toEqual([
      "independent_verification_missing",
      "independent_frontier_review_missing",
    ]);
    expect(corpus.exportTraining({ importerId }).recordCount).toBe(0);
  });
  it.each(["actor", "run", "hash", "verdict"] as const)(
    "quarantines non-independent or mismatched verification: %s",
    (field) => {
      const value = example();
      if (field === "actor") value.verification!.actorId = value.route.actorId;
      if (field === "run") value.verification!.runId = value.route.runId;
      if (field === "hash")
        value.verification!.subjectOutputSha256 = sha("different output");
      if (field === "verdict") value.verification!.verdict = "fail";
      expect(record(value).admissionReasons).toContain(
        "independent_verification_missing",
      );
    },
  );
  it("requires a frontier review separate from both producer and verifier", () => {
    const value = example();
    value.frontierReview!.actorId = value.verification!.actorId;
    expect(record(value).admissionReasons).toContain(
      "independent_frontier_review_missing",
    );
  });
  it.each([
    "subjectTaskId",
    "subjectInputSha256",
    "subjectRouteProfileSha256",
  ] as const)(
    "rejects review borrowed from a different task/input/route even when the output is identical: %s",
    (field) => {
      const value = example();
      const borrowed =
        field === "subjectTaskId" ? "another-task" : sha("another subject");
      value.verification![field] = borrowed;
      value.frontierReview![field] = borrowed;
      expect(record(value)).toMatchObject({
        disposition: "quarantined",
        admissionReasons: [
          "independent_verification_missing",
          "independent_frontier_review_missing",
        ],
      });
    },
  );
  it("quarantines a served model fallback without alias inference", () => {
    const value = example();
    value.route.servedModelId = "unexpected-fallback";
    expect(record(value)).toMatchObject({
      disposition: "quarantined",
      admissionReasons: ["served_model_mismatch"],
    });
  });
  it("keeps failures available for evaluation but outside positive training examples", () => {
    const value = example();
    corpus.registerHeldOut({
      importerId,
      taskLineageIds: [value.taskLineageId],
    });
    const result = record(value, "failed");
    expect(result).toMatchObject({
      disposition: "failed",
      trainingEligible: false,
      evaluationEligible: true,
    });
    expect(corpus.exportTraining({ importerId }).recordCount).toBe(0);
  });
  it("refuses a payload whose recorded hashes do not match", () => {
    const value = example();
    value.output = "unverified answer";
    expect(() => record(value)).toThrow("payload_hash_mismatch");
    expect(corpus.listMetadata()).toEqual([]);
  });
  it("accepts repeated identical imports idempotently", () => {
    const first = record();
    const second = record();
    expect(first).toEqual(second);
    expect(corpus.listMetadata()).toHaveLength(1);
  });
  it.each(["failed", "quarantined"] as const)(
    "rejects a conflicting %s import instead of silently preserving acceptance",
    (disposition) => {
      const { value, result } = admittedTrain();
      const ledgerPath = path.join(config.privateRoot, "ledger.json");
      const before = readFileSync(ledgerPath, "utf8");
      expect(() => record(value, disposition)).toThrow(
        "conflicting_admission_requires_revocation",
      );
      expect(readFileSync(ledgerPath, "utf8")).toBe(before);
      expect(
        corpus.listMetadata().find((item) => item.id === result.id),
      ).toEqual(result);
      corpus.revoke({
        importerId,
        target: "example",
        targetId: result.id,
        reasonCode: "later_review_failed",
      });
      expect(record(value)).toMatchObject({
        id: result.id,
        revoked: true,
        trainingEligible: false,
      });
    },
  );
  it("preserves identical failed requests across reopen and rejects a changed reason", () => {
    const request = {
      importerId,
      example: example(),
      disposition: "failed" as const,
      reasonCode: "test_failure",
    };
    const first = corpus.record(request);
    corpus.close();
    corpus = open();
    expect(corpus.record(request)).toEqual(first);
    expect(() =>
      corpus.record({ ...request, reasonCode: "different_failure" }),
    ).toThrow("conflicting_admission_requires_revocation");
    expect(corpus.listMetadata()).toEqual([first]);
  });
  it("keeps an accepted request idempotent after automatic quarantine and reopen", () => {
    const value = example();
    delete value.verification;
    const first = record(value);
    expect(first.disposition).toBe("quarantined");
    corpus.close();
    corpus = open();
    expect(record(value)).toEqual(first);
    expect(() => record(value, "quarantined")).toThrow(
      "conflicting_admission_requires_revocation",
    );
    expect(corpus.listMetadata()).toEqual([first]);
  });
  it("rejects a newly supplied admission reason for an already accepted example", () => {
    const first = record();
    expect(() =>
      corpus.record({
        importerId,
        example: example(),
        disposition: "accepted",
        reasonCode: "later_concern",
      }),
    ).toThrow("conflicting_admission_requires_revocation");
    expect(corpus.listMetadata()).toEqual([first]);
  });
  it("refuses an unknown importer, company, source kind or absent attestation", () => {
    expect(() =>
      corpus.record({
        importerId: "agent-untrusted",
        example: example(),
        disposition: "accepted",
      }),
    ).toThrow("importer_not_authorised");
    expect(() => open({ companyId: "another-company" })).toThrow(
      "corpus_operator_mismatch",
    );
    const value = example();
    value.sources[0]!.kind = "own_code";
    expect(() => record(value)).toThrow("source_kind_not_allowed");
    expect(() =>
      open({ attestation: { ...config.attestation, ownData: false } as never }),
    ).toThrow("invalid_record_fields");
  });
  it("requires every source in mixed-source work to be allowlisted", () => {
    const value = example();
    value.sources.push({
      id: "mixed-source",
      lineageId: "mixed-lineage",
      sha256: sha("other data"),
      kind: "own_document",
    });
    expect(() => record(value)).toThrow("source_kind_not_allowed");
    expect(corpus.listMetadata()).toEqual([]);
  });
  it("refuses credential-shaped strings in rejection and tombstone metadata too", () => {
    const reasonCode = "ghp_12345678901234567890";
    expect(() =>
      corpus.record({
        importerId,
        example: example(),
        disposition: "failed",
        reasonCode,
      }),
    ).toThrow("sensitive_or_reasoning_content");
    expect(() =>
      corpus.revoke({
        importerId,
        target: "source",
        targetId: "source-one",
        reasonCode,
      }),
    ).toThrow("sensitive_or_reasoning_content");
    expect(corpus.listMetadata()).toEqual([]);
  });
  it("refuses arbitrary additional fields including hidden reasoning", () => {
    expect(() =>
      record({ ...example(), reasoning: "private thought trace" } as never),
    ).toThrow("invalid_record_fields");
    const value = example();
    (value.route as unknown as Record<string, unknown>).environment = {
      private: "values",
    };
    expect(() => record(value)).toThrow("invalid_record_fields");
    expect(corpus.listMetadata()).toEqual([]);
  });
  it.each([
    "-----BEGIN PRIVATE KEY----- example",
    "Bearer not-a-real-token-123456",
    "api_key = synthetic-private-value",
    "xoxb-12345678901234567890",
    "ghp_12345678901234567890",
    "<analysis>not an allowed final output</analysis>",
  ])(
    "refuses credential-shaped or reasoning payload without writing it: %s",
    (content) => {
      const value = example();
      value.input = content;
      value.inputSha256 = sha(content);
      expect(() => record(value)).toThrow("sensitive_or_reasoning_content");
      expect(
        readFileSync(path.join(config.privateRoot, "ledger.json"), "utf8"),
      ).not.toContain(content);
    },
  );
  it.each([
    JSON.stringify({ token: "synthetic-private-value" }),
    JSON.stringify({
      response: JSON.stringify({ clientSecret: "synthetic-private-value" }),
    }),
    '{"\\u0074oken":"synthetic-private-value"}',
    "postgres://synthetic-user:synthetic-password@localhost/example",
  ])(
    "refuses accidental credentials in final output strings and nested JSON",
    (output) => {
      const value = example();
      value.output = output;
      value.outputSha256 = sha(output);
      expect(() => record(value)).toThrow("sensitive_or_reasoning_content");
      expect(corpus.listMetadata()).toEqual([]);
    },
  );
});

describe("partitioning, held-out reservation and revocation", () => {
  it("assigns source lineage, task lineage and normalised duplicate groups before partitioning", () => {
    const first = record();
    const sameSource = example("same-source");
    sameSource.sources[0]!.lineageId = example().sources[0]!.lineageId;
    expect(record(sameSource).split).toBe(first.split);
    const sameTask = example("same-task");
    sameTask.taskLineageId = example().taskLineageId;
    expect(record(sameTask).split).toBe(first.split);
    const duplicate = example("duplicate");
    duplicate.input = `  ${example().input.toUpperCase().replaceAll(" ", "\n ")} `;
    duplicate.inputSha256 = sha(duplicate.input);
    expect(record(duplicate).split).toBe(first.split);
    expect(corpus.listMetadata().map((m) => m.split)).toEqual(
      Array(4).fill(first.split),
    );
  });
  it("never exports a held-out source or its duplicate under a different lineage", () => {
    const value = example();
    corpus.registerHeldOut({
      importerId,
      sourceLineageIds: [value.sources[0]!.lineageId],
    });
    const first = record(value);
    const duplicate = example("duplicate");
    duplicate.input = value.input;
    duplicate.inputSha256 = sha(value.input);
    const second = record(duplicate);
    expect(first.split).toBe("held_out");
    expect(second.split).toBe("held_out");
    expect(corpus.exportTraining({ importerId }).recordCount).toBe(0);
  });
  it("honours pre-registered normalised input hashes and task lineages", () => {
    const one = example("one"),
      two = example("two");
    corpus.registerHeldOut({
      importerId,
      normalisedInputHashes: [normalisedLearningInputSha256(one.input)],
      taskLineageIds: [two.taskLineageId],
    });
    expect(record(one).split).toBe("held_out");
    expect(record(two).split).toBe("held_out");
  });
  it("invalidates exports and marks evaluation contamination when a previously exported lineage is reserved", () => {
    const { value, result } = admittedTrain();
    const exported = corpus.exportTraining({ importerId });
    expect(corpus.verifyExport(exported.exportId).recordCount).toBeGreaterThan(
      0,
    );
    const metadata = corpus
      .registerHeldOut({ importerId, taskLineageIds: [value.taskLineageId] })
      .find((m) => m.id === result.id)!;
    expect(metadata).toMatchObject({
      split: "held_out",
      trainingEligible: false,
      evaluationEligible: false,
      contaminatedByPriorTrainingExport: true,
    });
    expect(existsSync(exported.path)).toBe(false);
    expect(() => corpus.verifyExport(exported.exportId)).toThrow(
      "export_invalidated",
    );
  });
  it("prevents transitive leakage when a new example bridges training and held-out groups", () => {
    const { value } = admittedTrain();
    const held = example("held");
    corpus.registerHeldOut({
      importerId,
      taskLineageIds: [held.taskLineageId],
    });
    record(held);
    const bridge = example("bridge");
    bridge.taskLineageId = value.taskLineageId;
    bridge.sources[0]!.lineageId = held.sources[0]!.lineageId;
    record(bridge);
    const connected = corpus
      .listMetadata()
      .filter((m) =>
        [value.taskId, held.taskId, bridge.taskId].includes(m.taskId),
      );
    expect(
      connected.every((m) => m.split === "held_out" && !m.trainingEligible),
    ).toBe(true);
  });
  it("preserves source tombstones, removes stale exports and prevents re-import from reviving them", () => {
    const { value, result } = admittedTrain();
    const exported = corpus.exportTraining({ importerId });
    corpus.revoke({
      importerId,
      target: "source",
      targetId: value.sources[0]!.id,
      reasonCode: "permission_withdrawn",
    });
    expect(existsSync(exported.path)).toBe(false);
    expect(record(value)).toMatchObject({
      id: result.id,
      revoked: true,
      trainingEligible: false,
    });
    const differentVersion = structuredClone(value);
    differentVersion.taskId = "new-version";
    expect(record(differentVersion).revoked).toBe(true);
    corpus.close();
    corpus = open();
    expect(corpus.listMetadata().find((m) => m.id === result.id)!.revoked).toBe(
      true,
    );
    expect(
      JSON.parse(
        readFileSync(path.join(config.privateRoot, "ledger.json"), "utf8"),
      ).body.revocations,
    ).toHaveLength(1);
  });
  it("supports example tombstones without erasing historical provenance", () => {
    const result = record();
    corpus.revoke({
      importerId,
      target: "example",
      targetId: result.id,
      reasonCode: "review_invalidated",
    });
    expect(corpus.listMetadata()).toHaveLength(1);
    expect(corpus.listMetadata()[0]).toMatchObject({
      revoked: true,
      trainingEligible: false,
      evaluationEligible: false,
    });
  });
});

describe("private storage integrity and bounded export", () => {
  it("exports only eligible input/output pairs under its fixed private root with verified integrity", () => {
    admittedTrain();
    const exported = corpus.exportTraining({ importerId });
    expect(exported.path.startsWith(`${config.privateRoot}/exports/`)).toBe(
      true,
    );
    const raw = readFileSync(exported.path, "utf8");
    expect(sha(raw)).toBe(exported.sha256);
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(exported.recordCount);
    expect(
      records.every(
        (r) =>
          sha(r.output) === r.outputSha256 &&
          r.frontierReview.verdict === "pass",
      ),
    ).toBe(true);
    expect(lstatSync(exported.path).mode & 0o777).toBe(0o600);
    expect(() =>
      corpus.exportTraining({
        importerId,
        path: path.join(temporary, "outside.jsonl"),
      } as never),
    ).toThrow("invalid_record_fields");
  });
  it("detects ledger and export tampering", () => {
    admittedTrain();
    const exported = corpus.exportTraining({ importerId });
    writeFileSync(exported.path, "tampered", { mode: 0o600 });
    expect(() => corpus.verifyExport(exported.exportId)).toThrow(
      "integrity_failure",
    );
    const ledgerPath = path.join(config.privateRoot, "ledger.json");
    const body = JSON.parse(readFileSync(ledgerPath, "utf8"));
    body.body.records[0].example.output = "changed";
    writeFileSync(ledgerPath, JSON.stringify(body));
    expect(() => corpus.listMetadata()).toThrow("integrity_failure");
  });
  it("rejects group-readable files and directories instead of silently correcting them", () => {
    chmodSync(path.join(config.privateRoot, "ledger.json"), 0o640);
    expect(() => corpus.listMetadata()).toThrow("unsafe_private_file");
    chmodSync(path.join(config.privateRoot, "ledger.json"), 0o600);
    chmodSync(config.privateRoot, 0o750);
    expect(() => corpus.listMetadata()).toThrow(
      "private_directory_permissions",
    );
  });
  it("rejects symlink and hardlink ledger substitution", () => {
    const ledger = path.join(config.privateRoot, "ledger.json");
    const outside = path.join(temporary, "outside");
    renameSync(ledger, outside);
    symlinkSync(outside, ledger);
    expect(() => corpus.listMetadata()).toThrow();
    unlinkSync(ledger);
    linkSync(outside, ledger);
    expect(() => corpus.listMetadata()).toThrow("unsafe_private_file");
    expect(readFileSync(outside, "utf8")).toContain('"records":[]');
  });
  it("rejects a root symlink and a symlinked export directory", () => {
    const alias = path.join(temporary, "alias");
    symlinkSync(config.privateRoot, alias);
    expect(() => open({ privateRoot: alias })).toThrow("unsafe_directory");
    const exports = path.join(config.privateRoot, "exports"),
      moved = path.join(config.privateRoot, "saved-exports");
    renameSync(exports, moved);
    symlinkSync(moved, exports);
    expect(() => corpus.exportTraining({ importerId })).toThrow(
      "private_root_changed",
    );
  });
  it("rejects Git, explicit workspace, sync and non-canonical roots", () => {
    const git = path.join(temporary, "git");
    mkdirSync(git, { mode: 0o700 });
    writeFileSync(path.join(git, ".git"), "gitdir: synthetic");
    expect(() => open({ privateRoot: path.join(git, "private") })).toThrow(
      "git_workspace_root",
    );
    expect(() =>
      open({ privateRoot: path.join(temporary, "workspace", "private") }),
    ).toThrow("workspace_overlap");
    expect(() =>
      open({ privateRoot: path.join(temporary, "OneDrive", "private") }),
    ).toThrow("sync_or_external_root");
    expect(() =>
      open({ privateRoot: `${temporary}/something/../private` }),
    ).toThrow("private_root_must_be_absolute_canonical");
  });
  it("resolves symlinked workspace exclusions before checking containment", () => {
    const alias = path.join(temporary, "workspace-alias");
    symlinkSync(config.privateRoot, alias);
    expect(() => open({ excludedRoots: [alias] })).toThrow("workspace_overlap");
  });
  it("refuses stale/concurrent locks without stealing ownership or deleting them", () => {
    const lock = path.join(config.privateRoot, ".lock");
    writeFileSync(lock, "999999", { mode: 0o600 });
    expect(() => record()).toThrow("corpus_locked_or_unsafe");
    expect(readFileSync(lock, "utf8")).toBe("999999");
  });
  it("enforces payload, record-count, ledger and total-storage bounds without corrupting prior state", () => {
    corpus.close();
    corpus = open({ maxPayloadBytes: 64, maxRecords: 1 });
    const value = example();
    value.output = "x".repeat(65);
    value.outputSha256 = sha(value.output);
    expect(() => record(value)).toThrow("payload_limit");
    record();
    expect(() => record(example("second"))).toThrow("corpus_record_limit");
    expect(corpus.listMetadata()).toHaveLength(1);
    corpus.close();
    corpus = open({ maxLedgerBytes: 4096, maxTotalBytes: 8192 });
    const huge = example("huge");
    huge.input = "a".repeat(5000);
    huge.inputSha256 = sha(huge.input);
    expect(() => record(huge)).toThrow("corpus_ledger_limit");
    expect(corpus.listMetadata()).toHaveLength(1);
    expect(
      readdirSync(config.privateRoot).filter((name) =>
        name.startsWith(".tmp-"),
      ),
    ).toEqual([]);
  });
  it("enforces total storage including snapshot replacement headroom", () => {
    corpus.close();
    corpus = open({ maxTotalBytes: 2000 });
    expect(() => record()).toThrow("corpus_storage_limit");
    expect(corpus.listMetadata()).toEqual([]);
  });
});

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/\[\]-]{0,199}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const sourceKind = z.enum([
  "own_task_prompt",
  "own_document",
  "own_code",
  "synthetic_owned",
]);
const split = z.enum(["train", "validation", "held_out"]);
const disposition = z.enum(["accepted", "failed", "quarantined"]);
const verification = z.strictObject({
  actorId: id,
  runId: id,
  method: z.enum(["test_run", "human_review", "artifact_check"]),
  verdict: z.enum(["pass", "fail"]),
  subjectTaskId: id,
  subjectInputSha256: hash,
  subjectOutputSha256: hash,
  subjectRouteProfileSha256: hash,
  evidenceSha256: hash,
});
const review = z.strictObject({
  actorId: id,
  runId: id,
  modelId: id,
  frontier: z.literal(true),
  verdict: z.enum(["pass", "fail"]),
  subjectTaskId: id,
  subjectInputSha256: hash,
  subjectOutputSha256: hash,
  subjectRouteProfileSha256: hash,
  evidenceSha256: hash,
});
const exampleSchema = z.strictObject({
  taskId: id,
  taskLineageId: id,
  taskClass: id,
  sources: z
    .array(
      z.strictObject({ id, lineageId: id, kind: sourceKind, sha256: hash }),
    )
    .min(1)
    .max(32),
  route: z.strictObject({
    profileId: id,
    profileSha256: hash,
    requestedModelId: id,
    expectedServedModelId: id,
    servedModelId: id,
    effort: id,
    harness: id,
    harnessVersion: id,
    accountRef: id,
    runtimeId: id,
    actorId: id,
    runId: id,
  }),
  input: z.string().max(1024 * 1024),
  output: z.string().max(1024 * 1024),
  inputSha256: hash,
  outputSha256: hash,
  verification: verification.optional(),
  frontierReview: review.optional(),
});
export type LocalLearningExample = z.infer<typeof exampleSchema>;
export type LocalLearningDisposition = z.infer<typeof disposition>;
export type LocalLearningSplit = z.infer<typeof split>;
const attestationSchema = z.strictObject({
  id,
  attestedBy: id,
  attestedAt: date,
  ownData: z.literal(true),
  localUseOnly: z.literal(true),
  storageOutsideWorkspacesAndSync: z.literal(true),
});
const configSchema = z.strictObject({
  privateRoot: z.string().min(1),
  excludedRoots: z.array(z.string().min(1)).min(1),
  companyId: id,
  importerId: id,
  attestation: attestationSchema,
  allowedSourceKinds: z.array(sourceKind).min(1),
  maxPayloadBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(256 * 1024),
  maxLedgerBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  maxTotalBytes: z
    .number()
    .int()
    .min(1024)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  maxRecords: z.number().int().min(1).max(10_000).default(1000),
});
export type LocalLearningCorpusConfig = z.input<typeof configSchema>;
const recordSchema = z.strictObject({
  id: hash,
  recordedAt: date,
  admissionRequest: z.strictObject({
    disposition,
    reasonCode: id.optional(),
  }),
  disposition,
  split,
  admissionReasons: z.array(id),
  example: exampleSchema,
});
const exportSchema = z.strictObject({
  id: hash,
  createdAt: date,
  recordIds: z.array(hash),
  sha256: hash,
});
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().min(0),
  companyId: id,
  importerId: id,
  attestation: attestationSchema,
  records: z.array(recordSchema),
  heldOutKeys: z.array(z.string()),
  revocations: z.array(
    z.strictObject({
      id: hash,
      at: date,
      target: z.enum(["source", "example"]),
      targetId: id,
      reasonCode: id,
    }),
  ),
  exports: z.array(exportSchema),
});
type Ledger = z.infer<typeof ledgerSchema>;
type CorpusRecord = z.infer<typeof recordSchema>;
export interface LocalLearningRecordMetadata {
  id: string;
  taskId: string;
  taskClass: string;
  recordedAt: string;
  disposition: LocalLearningDisposition;
  split: LocalLearningSplit;
  inputSha256: string;
  outputSha256: string;
  normalisedInputSha256: string;
  route: LocalLearningExample["route"];
  sourceIds: string[];
  admissionReasons: string[];
  revoked: boolean;
  trainingEligible: boolean;
  evaluationEligible: boolean;
  contaminatedByPriorTrainingExport: boolean;
}
export class LocalLearningCorpusError extends Error {
  constructor(readonly code: string) {
    super(`Local learning corpus: ${code}`);
  }
}
function deny(code: string): never {
  throw new LocalLearningCorpusError(code);
}
export function localLearningSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function normalisedLearningInputSha256(value: string): string {
  return localLearningSha256(
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim(),
  );
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) deny("invalid_record_fields");
  return result.data;
}
function checkText(value: string) {
  // Refuse rather than persist a redacted example whose evidence hashes no longer match.
  const scan = value
    .replace(/\\u([a-f0-9]{4})/giu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\+(["'])/gu, "$1");
  if (
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?|xox[baprs]-|gh[pousr]_|github_pat_|xai-)[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization|token|cookie)\b\s*["']?\s*[:=]\s*["']?[^\s"']{4,}|\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@|<\/?(?:think|thinking|analysis|reasoning)>|\b(?:chain_of_thought|reasoning_content|hidden_reasoning)\b)/iu.test(
      scan,
    )
  ) {
    deny("sensitive_or_reasoning_content");
  }
}
function within(candidate: string, root: string) {
  const rel = path.relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
function keysFor(example: LocalLearningExample) {
  return [
    `task:${example.taskLineageId}`,
    ...example.sources.map((source) => `source:${source.lineageId}`),
    `input:${normalisedLearningInputSha256(example.input)}`,
  ];
}
function admissionReasons(example: LocalLearningExample): string[] {
  const reasons: string[] = [];
  if (example.route.servedModelId !== example.route.expectedServedModelId)
    reasons.push("served_model_mismatch");
  const v = example.verification;
  function matchesSubject(
    evidence: z.infer<typeof verification> | z.infer<typeof review>,
  ) {
    return (
      evidence.subjectTaskId === example.taskId &&
      evidence.subjectInputSha256 === example.inputSha256 &&
      evidence.subjectOutputSha256 === example.outputSha256 &&
      evidence.subjectRouteProfileSha256 === example.route.profileSha256
    );
  }
  if (
    !v ||
    v.verdict !== "pass" ||
    !matchesSubject(v) ||
    v.runId === example.route.runId ||
    v.actorId === example.route.actorId
  )
    reasons.push("independent_verification_missing");
  const r = example.frontierReview;
  if (
    !r ||
    r.verdict !== "pass" ||
    !matchesSubject(r) ||
    r.runId === example.route.runId ||
    r.actorId === example.route.actorId ||
    r.runId === v?.runId ||
    r.actorId === v?.actorId
  )
    reasons.push("independent_frontier_review_missing");
  return reasons;
}
function projections(ledger: Ledger): LocalLearningRecordMetadata[] {
  const parent = new Map<string, string>();
  function find(key: string): string {
    const p = parent.get(key);
    if (!p) {
      parent.set(key, key);
      return key;
    }
    if (p === key) return key;
    const root = find(p);
    parent.set(key, root);
    return root;
  }
  for (const record of ledger.records) {
    const keys = keysFor(record.example);
    const first = find(keys[0]!);
    for (const key of keys.slice(1)) parent.set(find(key), first);
  }
  const groups = new Map<string, CorpusRecord[]>();
  for (const record of ledger.records) {
    const group = find(keysFor(record.example)[0]!);
    groups.set(group, [...(groups.get(group) ?? []), record]);
  }
  const reserved = new Set(ledger.heldOutKeys.map(find));
  const exported = new Set(ledger.exports.flatMap((entry) => entry.recordIds));
  const revokedExamples = new Set(
    ledger.revocations
      .filter((r) => r.target === "example")
      .map((r) => r.targetId),
  );
  const revokedSources = new Set(
    ledger.revocations
      .filter((r) => r.target === "source")
      .map((r) => r.targetId),
  );
  const rank = { train: 0, validation: 1, held_out: 2 };
  return ledger.records.map((record) => {
    const group = find(keysFor(record.example)[0]!);
    const members = groups.get(group)!;
    const effectiveSplit = reserved.has(group)
      ? "held_out"
      : members.reduce<LocalLearningSplit>(
          (current, member) =>
            rank[member.split] > rank[current] ? member.split : current,
          "train",
        );
    const revoked =
      revokedExamples.has(record.id) ||
      record.example.sources.some((s) => revokedSources.has(s.id));
    const contaminated =
      effectiveSplit !== "train" && members.some((r) => exported.has(r.id));
    return {
      id: record.id,
      taskId: record.example.taskId,
      taskClass: record.example.taskClass,
      recordedAt: record.recordedAt,
      disposition: record.disposition,
      split: effectiveSplit,
      inputSha256: record.example.inputSha256,
      outputSha256: record.example.outputSha256,
      normalisedInputSha256: normalisedLearningInputSha256(
        record.example.input,
      ),
      route: record.example.route,
      sourceIds: record.example.sources.map((s) => s.id),
      admissionReasons: record.admissionReasons,
      revoked,
      trainingEligible:
        record.disposition === "accepted" &&
        !revoked &&
        effectiveSplit === "train",
      evaluationEligible:
        !revoked && !contaminated && effectiveSplit !== "train",
      contaminatedByPriorTrainingExport: contaminated,
    };
  });
}

/**
 * Local importer only. No agent route, network transport, run-log scraping or upload is provided.
 * Importer IDs and attestations express the trusted caller's claims, not cryptographic identity.
 * The caller must authenticate its source and verify evidence before invoking this library.
 */
export function openLocalLearningCorpus(
  inputConfig: LocalLearningCorpusConfig,
) {
  const config = parse(configSchema, inputConfig);
  checkText(JSON.stringify(config));
  if (process.platform !== "linux" || !process.getuid)
    deny("unsupported_private_filesystem");
  const uid = process.getuid();
  const root = path.resolve(config.privateRoot);
  if (!path.isAbsolute(config.privateRoot) || root !== config.privateRoot)
    deny("private_root_must_be_absolute_canonical");
  function resolveExclusion(value: string): string {
    const absolute = path.resolve(value);
    let ancestor = absolute;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor)
      ancestor = path.dirname(ancestor);
    return path.resolve(
      realpathSync(ancestor),
      path.relative(ancestor, absolute),
    );
  }
  if (
    config.excludedRoots.some(
      (r) =>
        !path.isAbsolute(r) ||
        within(root, resolveExclusion(r)) ||
        within(resolveExclusion(r), root),
    )
  )
    deny("workspace_overlap");
  if (
    /(?:^|\/)(?:mnt|media|net|onedrive|dropbox|google drive|gdrive|icloud|nextcloud|syncthing)(?:\/|$)/iu.test(
      root,
    )
  )
    deny("sync_or_external_root");
  function checkAncestors() {
    let current = root;
    while (true) {
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          deny("unsafe_directory");
        if (info.uid !== uid && info.uid !== 0) deny("unsafe_directory_owner");
        if (
          (info.mode & 0o022) !== 0 &&
          !(current === "/tmp" && info.mode & 0o1000)
        )
          deny("writable_ancestor");
        if (existsSync(path.join(current, ".git"))) deny("git_workspace_root");
      }
      const next = path.dirname(current);
      if (next === current) break;
      current = next;
    }
  }
  checkAncestors();
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const rootFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const rootRef = `/proc/self/fd/${rootFd}`;
  let exportsFd: number | undefined;
  let closed = false;
  function assertDirectory(fd: number) {
    const info = fstatSync(fd);
    if (
      !info.isDirectory() ||
      info.uid !== uid ||
      (info.mode & 0o777) !== 0o700
    )
      deny("private_directory_permissions");
  }
  function checkRoot() {
    if (closed) deny("corpus_closed");
    checkAncestors();
    assertDirectory(rootFd);
    if (realpathSync(rootRef) !== root || realpathSync(root) !== root)
      deny("private_root_changed");
    const held = fstatSync(rootFd),
      named = lstatSync(root);
    if (held.dev !== named.dev || held.ino !== named.ino)
      deny("private_root_changed");
    // Fail closed for network, FUSE, Windows/WSL drive, overlay and unknown filesystems.
    if (![0xef53, 0x58465342, 0x9123683e].includes(statfsSync(rootRef).type))
      deny("unsupported_private_filesystem");
  }
  function fileInfo(file: string) {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== uid ||
      (info.mode & 0o777) !== 0o600
    )
      deny("unsafe_private_file");
    return info;
  }
  function readPrivate(file: string, max: number) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      const named = fileInfo(file);
      if (info.dev !== named.dev || info.ino !== named.ino || info.size > max)
        deny("private_file_bound_or_identity");
      const bytes = readFileSync(fd);
      if (bytes.length > max) deny("private_file_bound_or_identity");
      return bytes.toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
  function allBytes() {
    let total = 0;
    for (const name of readdirSync(rootRef)) {
      if (name === "exports") continue;
      if (
        name !== "ledger.json" &&
        name !== ".lock" &&
        !/^\.tmp-[a-f0-9-]{36}$/.test(name)
      )
        deny("unexpected_private_file");
      total += fileInfo(path.join(rootRef, name)).size;
    }
    for (const name of readdirSync(`/proc/self/fd/${exportsFd}`)) {
      if (!/^[a-f0-9]{64}\.jsonl$/.test(name)) deny("unexpected_private_file");
      total += fileInfo(`/proc/self/fd/${exportsFd}/${name}`).size;
    }
    return total;
  }
  function writePrivate(file: string, content: string) {
    if (allBytes() + Buffer.byteLength(content) > config.maxTotalBytes)
      deny("corpus_storage_limit");
    const fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (
      localLearningSha256(readPrivate(file, config.maxTotalBytes)) !==
      localLearningSha256(content)
    )
      deny("integrity_failure");
  }
  function load(): Ledger {
    const raw = readPrivate(
      path.join(rootRef, "ledger.json"),
      config.maxLedgerBytes,
    );
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      deny("integrity_failure");
    }
    const result = parse(
      z.strictObject({ sha256: hash, body: ledgerSchema }),
      envelope,
    );
    if (localLearningSha256(JSON.stringify(result.body)) !== result.sha256)
      deny("integrity_failure");
    if (
      result.body.companyId !== config.companyId ||
      result.body.importerId !== config.importerId ||
      JSON.stringify(result.body.attestation) !==
        JSON.stringify(config.attestation)
    )
      deny("corpus_operator_mismatch");
    if (result.body.records.length > config.maxRecords)
      deny("corpus_record_limit");
    for (const record of result.body.records) {
      if (
        localLearningSha256(JSON.stringify(record.example)) !== record.id ||
        localLearningSha256(record.example.input) !==
          record.example.inputSha256 ||
        localLearningSha256(record.example.output) !==
          record.example.outputSha256 ||
        (record.disposition === "accepted" &&
          admissionReasons(record.example).length)
      )
        deny("integrity_failure");
    }
    return result.body;
  }
  function save(ledger: Ledger) {
    ledger.revision += 1;
    const canonical = parse(ledgerSchema, ledger);
    const bytes = JSON.stringify({
      sha256: localLearningSha256(JSON.stringify(canonical)),
      body: canonical,
    });
    if (Buffer.byteLength(bytes) > config.maxLedgerBytes)
      deny("corpus_ledger_limit");
    const temp = path.join(rootRef, `.tmp-${randomUUID()}`);
    try {
      writePrivate(temp, bytes);
      const destination = path.join(rootRef, "ledger.json");
      if (existsSync(destination)) fileInfo(destination);
      renameSync(temp, destination);
      fsyncSync(rootFd);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function locked<T>(operation: () => T): T {
    checkRoot();
    assertDirectory(exportsFd!);
    if (
      realpathSync(`/proc/self/fd/${exportsFd}`) !== path.join(root, "exports")
    )
      deny("private_root_changed");
    const lockPath = path.join(rootRef, ".lock");
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      deny("corpus_locked_or_unsafe");
    }
    try {
      writeFileSync(fd, String(process.pid), "utf8");
      fsyncSync(fd);
      if (allBytes() > config.maxTotalBytes) deny("corpus_storage_limit");
      return operation();
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  }
  function authorise(importerId: string) {
    if (importerId !== config.importerId) deny("importer_not_authorised");
  }
  function exportPath(exportId: string) {
    return `/proc/self/fd/${exportsFd}/${exportId}.jsonl`;
  }
  function exportValid(ledger: Ledger, recordIds: string[]) {
    const eligible = new Set(
      projections(ledger)
        .filter((m) => m.trainingEligible)
        .map((m) => m.id),
    );
    return recordIds.every((recordId) => eligible.has(recordId));
  }
  function retireInvalidExports(ledger: Ledger) {
    for (const item of ledger.exports) {
      if (
        !exportValid(ledger, item.recordIds) &&
        existsSync(exportPath(item.id))
      ) {
        fileInfo(exportPath(item.id));
        unlinkSync(exportPath(item.id));
      }
    }
    fsyncSync(exportsFd!);
  }
  try {
    checkRoot();
    const directory = path.join(rootRef, "exports");
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    exportsFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    assertDirectory(exportsFd);
    locked(() => {
      if (existsSync(path.join(rootRef, "ledger.json"))) load();
      else
        save({
          version: 1,
          revision: 0,
          companyId: config.companyId,
          importerId: config.importerId,
          attestation: config.attestation,
          records: [],
          heldOutKeys: [],
          revocations: [],
          exports: [],
        });
    });
  } catch (error) {
    if (exportsFd !== undefined) closeSync(exportsFd);
    closeSync(rootFd);
    throw error;
  }
  return {
    record(input: {
      importerId: string;
      example: LocalLearningExample;
      disposition: LocalLearningDisposition;
      reasonCode?: string;
    }): LocalLearningRecordMetadata {
      authorise(input.importerId);
      parse(
        z.strictObject({
          importerId: id,
          example: exampleSchema,
          disposition,
          reasonCode: id.optional(),
        }),
        input,
      );
      const example = parse(exampleSchema, input.example);
      if (
        Buffer.byteLength(example.input) > config.maxPayloadBytes ||
        Buffer.byteLength(example.output) > config.maxPayloadBytes
      )
        deny("payload_limit");
      checkText(example.input);
      checkText(example.output);
      checkText(JSON.stringify(input));
      if (
        !example.sources.every((s) =>
          config.allowedSourceKinds.includes(s.kind),
        )
      )
        deny("source_kind_not_allowed");
      if (
        localLearningSha256(example.input) !== example.inputSha256 ||
        localLearningSha256(example.output) !== example.outputSha256
      )
        deny("payload_hash_mismatch");
      if (input.disposition !== "accepted" && !input.reasonCode)
        deny("failure_reason_required");
      return locked(() => {
        const ledger = load();
        const exampleId = localLearningSha256(JSON.stringify(example));
        const existing = ledger.records.find(
          (record) => record.id === exampleId,
        );
        if (existing) {
          if (
            existing.admissionRequest.disposition !== input.disposition ||
            existing.admissionRequest.reasonCode !== input.reasonCode
          )
            deny("conflicting_admission_requires_revocation");
          return projections(ledger).find((m) => m.id === exampleId)!;
        }
        if (ledger.records.length >= config.maxRecords)
          deny("corpus_record_limit");
        const reasons = admissionReasons(example);
        if (input.reasonCode) reasons.push(input.reasonCode);
        const bucket =
          Number.parseInt(
            localLearningSha256(keysFor(example).sort().join("\n")).slice(0, 8),
            16,
          ) % 10;
        const newKeys = new Set(keysFor(example));
        const linkedIds = new Set(
          ledger.records
            .filter((r) => keysFor(r.example).some((key) => newKeys.has(key)))
            .map((r) => r.id),
        );
        const linkedSplits = projections(ledger)
          .filter((m) => linkedIds.has(m.id))
          .map((m) => m.split);
        const assignedSplit: LocalLearningSplit = linkedSplits.includes(
          "held_out",
        )
          ? "held_out"
          : linkedSplits.includes("validation")
            ? "validation"
            : linkedSplits.length
              ? "train"
              : bucket < 8
                ? "train"
                : bucket === 8
                  ? "validation"
                  : "held_out";
        ledger.records.push({
          id: exampleId,
          recordedAt: new Date().toISOString(),
          example,
          admissionRequest: {
            disposition: input.disposition,
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          },
          disposition:
            input.disposition === "accepted" && reasons.length
              ? "quarantined"
              : input.disposition,
          split: assignedSplit,
          admissionReasons: reasons,
        });
        save(ledger);
        retireInvalidExports(ledger);
        return projections(ledger).find((m) => m.id === exampleId)!;
      });
    },
    listMetadata(): LocalLearningRecordMetadata[] {
      return locked(() => projections(load()));
    },
    registerHeldOut(input: {
      importerId: string;
      sourceLineageIds?: string[];
      taskLineageIds?: string[];
      normalisedInputHashes?: string[];
    }) {
      authorise(input.importerId);
      const selection = parse(
        z.strictObject({
          importerId: id,
          sourceLineageIds: z.array(id).max(1000).optional(),
          taskLineageIds: z.array(id).max(1000).optional(),
          normalisedInputHashes: z.array(hash).max(1000).optional(),
        }),
        input,
      );
      checkText(JSON.stringify(selection));
      const keys = [
        ...(selection.sourceLineageIds ?? []).map((s) => `source:${s}`),
        ...(selection.taskLineageIds ?? []).map((s) => `task:${s}`),
        ...(selection.normalisedInputHashes ?? []).map((s) => `input:${s}`),
      ];
      if (!keys.length) deny("held_out_selection_required");
      return locked(() => {
        const ledger = load();
        ledger.heldOutKeys = [...new Set([...ledger.heldOutKeys, ...keys])];
        save(ledger);
        retireInvalidExports(ledger);
        return projections(ledger);
      });
    },
    revoke(input: {
      importerId: string;
      target: "source" | "example";
      targetId: string;
      reasonCode: string;
    }) {
      authorise(input.importerId);
      const revocation = parse(
        z.strictObject({
          importerId: id,
          target: z.enum(["source", "example"]),
          targetId: id,
          reasonCode: id,
        }),
        input,
      );
      checkText(JSON.stringify(revocation));
      return locked(() => {
        const ledger = load();
        const revocationId = localLearningSha256(JSON.stringify(revocation));
        if (!ledger.revocations.some((r) => r.id === revocationId)) {
          ledger.revocations.push({
            id: revocationId,
            at: new Date().toISOString(),
            target: revocation.target,
            targetId: revocation.targetId,
            reasonCode: revocation.reasonCode,
          });
          save(ledger);
        }
        retireInvalidExports(ledger);
        return projections(ledger);
      });
    },
    exportTraining(input: { importerId: string }) {
      authorise(input.importerId);
      parse(z.strictObject({ importerId: id }), input);
      return locked(() => {
        const ledger = load();
        const eligible = new Set(
          projections(ledger)
            .filter((m) => m.trainingEligible)
            .map((m) => m.id),
        );
        const records = ledger.records.filter((r) => eligible.has(r.id));
        const data =
          records
            .map((r) =>
              JSON.stringify({
                exampleId: r.id,
                input: r.example.input,
                output: r.example.output,
                inputSha256: r.example.inputSha256,
                outputSha256: r.example.outputSha256,
                route: r.example.route,
                verification: r.example.verification,
                frontierReview: r.example.frontierReview,
                sourceIds: r.example.sources.map((s) => s.id),
              }),
            )
            .join("\n") + (records.length ? "\n" : "");
        const sha256 = localLearningSha256(data);
        const exportId = localLearningSha256(
          JSON.stringify({
            revision: ledger.revision,
            sha256,
            nonce: randomUUID(),
          }),
        );
        writePrivate(exportPath(exportId), data);
        fsyncSync(exportsFd!);
        try {
          ledger.exports.push({
            id: exportId,
            createdAt: new Date().toISOString(),
            recordIds: records.map((r) => r.id),
            sha256,
          });
          save(ledger);
        } catch (error) {
          unlinkSync(exportPath(exportId));
          throw error;
        }
        return {
          exportId,
          sha256,
          recordCount: records.length,
          path: path.join(root, "exports", `${exportId}.jsonl`),
        };
      });
    },
    verifyExport(exportId: string) {
      parse(hash, exportId);
      return locked(() => {
        const ledger = load();
        const item = ledger.exports.find((entry) => entry.id === exportId);
        if (!item || !exportValid(ledger, item.recordIds))
          deny("export_invalidated");
        if (
          localLearningSha256(
            readPrivate(exportPath(exportId), config.maxTotalBytes),
          ) !== item.sha256
        )
          deny("integrity_failure");
        return {
          exportId,
          sha256: item.sha256,
          recordCount: item.recordIds.length,
        };
      });
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(exportsFd!);
        closeSync(rootFd);
      }
    },
  };
}

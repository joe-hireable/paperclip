# Local learning corpus

`server/src/services/local-learning-corpus.ts` is a bounded, local importer library
for owned task inputs and final work products. It has no HTTP endpoint, network
client, telemetry, attachment upload, cloud export, credential reader, training
job or automatic run-log collector. The contributed code and synthetic tests
contain no operator data or model weights.

## Trust and configuration

The operator configures one absolute private root, company, importer identity,
source-kind allowlist and attestation of own-data permission and local-only use.
The attestation records an existing user decision; the library does not offer
legal conclusions or request another approval. The importer is trusted local
operator code, not a model tool exposed to arbitrary agents. A supplied identity,
model name, evidence digest or `frontier: true` flag is an attested reference,
not cryptographic proof of who performed the work. The importer must resolve
and check the actual independent evidence before admitting an example.

This initial implementation supports Linux ext4, XFS and Btrfs. It fails closed
for unknown, network, FUSE, overlay, Windows-mounted and volatile filesystems.
The root must be outside every explicitly excluded workspace, Git ancestry and
recognised sync/mount paths. All known workspace, backup and sync roots must be
configured as exclusions. An operator must also ensure the private root is not
selected by a synchronisation or backup program: filesystem metadata cannot
detect an arbitrary cloud uploader or stop a trusted owner uploading a file.

Private directories must belong to the current OS user and have mode `0700`;
files must have mode `0600` and a single hard link. Parent directories cannot be
symlinks or writable by other users (the conventional sticky `/tmp` ancestor is
permitted, but a corpus on tmpfs is rejected). Existing insecure permissions are
refused, not changed silently. Pinned directory descriptors, inode checks and
no-follow file opens prevent path substitution from redirecting corpus reads or
writes. These protections do not isolate an adversary running as the same OS
user or root. Run untrusted harness processes under a separate user/sandbox if
they must not access this data.

The fixed limits default to 1,000 records, 256 KiB per input/output, a 16 MiB
ledger and 64 MiB of logical file content including atomic-write headroom and
exports. This is a bounded first corpus, not an unbounded data lake.

## Admission

`openLocalLearningCorpus(config)` exposes:

- `record({ importerId, example, disposition, reasonCode? })`: immutable import,
  idempotent for an identical example and requested disposition/reason. A conflicting
  import fails with `conflicting_admission_requires_revocation`; it cannot silently
  preserve a prior accepted record. A requested positive record without
  all evidence becomes `quarantined`; explicit failures remain `failed`.
- `listMetadata()`: provenance and current admission/split status, excluding raw
  input and output.
- `registerHeldOut({ importerId, sourceLineageIds?, taskLineageIds?, normalisedInputHashes? })`:
  reserve evaluation groups before collection, or mark newly discovered overlap.
- `revoke({ importerId, target: 'source' | 'example', targetId, reasonCode })`:
  append a tombstone; retain historical provenance and prevent future admission
  of the revoked source/example into exports.
- `exportTraining({ importerId })`: produce JSONL solely inside the configured
  root's `exports` directory. There is no target-path argument.
- `verifyExport(exportId)`: verify the file digest and its continued admission
  against current tombstones and split reservations.
- `close()`: release private directory handles.

An example records task and source lineage, source hashes, exact route profile
and profile hash, requested picker model, expected served model, actual served
model, effort, harness/version, account reference, runtime/producer identity,
input/output and their hashes. Requested and served IDs may legitimately differ;
the actual served ID must exactly match the attested route's expected served ID.
No alias guessing or unexpected fallback is accepted.

Positive admission needs a passing independent verifier and a separate passing
frontier review. Both bind the exact task ID, input hash, output hash and route
profile hash, alongside their independent evidence hashes;
producer, verifier and reviewer actor/run identities must be distinct. Exit
codes, file existence and producer self-assessments are not admission signals.
Failures and quarantine remain labelled records for evaluation/analysis and
never appear as positive training examples. Evidence changes produce a new
immutable example rather than rewriting the earlier assessment.

Source kinds are restricted to owned prompts/documents/code and owned synthetic
fixtures. Unknown fields, environment dumps and reasoning fields are refused.
Input/output are the only free-form payload fields. Credential-shaped material,
known token/key forms, credential URLs and explicit hidden-reasoning markers
are refused before persistence. Refusal is preferable to redaction here because
redacting would break the evidence hashes. Pattern matching cannot identify
every arbitrary secret or disguised reasoning trace: the trusted importer must
select final work products and sanitised owned inputs, never indiscriminately
copy provider traces, system prompts, credentials or tool logs. Errors contain
stable reason codes, not rejected payloads.

## Evaluation separation and invalidation

Source lineage, task lineage and Unicode/whitespace/case-normalised input hashes
form connected groups before partitioning. New groups receive deterministic
80/10/10 train/validation/held-out assignment. New members inherit an existing
group's split. Group merges can only make a split more restrictive; validation
and held-out groups never become training data. Reserve benchmark lineages before
using them. Normalisation is deliberately conservative, not semantic duplicate
detection; the importer must supply correct lineage for related/rephrased work.

A later bridge between groups restricts every connected record. If any connected
record was previously exported for training, the reserved evaluation group is
marked contaminated and is ineligible for evaluation. Training records are also
ineligible as unbiased evaluation data. Failed records can be evaluation cases
only within an uncontaminated validation/held-out group.

Source/example tombstones and export provenance are retained in the ledger.
Exports that become invalid are removed; the immutable ledger retains their
record IDs and digests. A consumer must call `verifyExport` immediately before
training and must not copy examples into an unmanaged destination. Revocation
cannot retract already trained weights, an already open file descriptor or a
copy made outside this library. Retraining/invalidation of derived local models
requires that future training runner to track export IDs and model lineage.

## Persistence and recovery

Every operation takes an exclusive local lock. Ledger replacement uses a new
private file, flush, integrity readback, atomic rename and directory flush.
Export files are likewise private and checked; an export is usable only when its
matching ledger entry validates. Hashes detect corruption, not forgery by the
trusted local operator. No untrusted agent may edit the ledger.

A process crash can leave a lock or unpublished temporary/export file. Recovery
fails closed: a local operator checks that the recorded process no longer owns
an active import, preserves the ledger, and removes only the stale lock or
unreferenced private files. There is no automatic lock stealing, replay, external
backup or export. Validation must precede reuse after recovery.

Focused tests exercise real local filesystem writes and synthetic records only:
admission evidence, explicit served model matching, secrets, unknown fields,
transitive partition overlap, held-out contamination, tombstones, digest tamper,
symlink/hardlink substitution, permissions, locks and byte/count limits. The
library is not yet wired to automatic routing, run capture or local training.

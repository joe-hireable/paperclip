import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
// Server-produced manifest references only. This is not an admission capability.
export const coordinatorDeliveryManifestSchema = z
  .object({
    version: z.literal(1),
    toolTransport: z.literal("sdk_mcp_v1"),
    runId: z.string().uuid(),
    companyId: z.string().uuid(),
    attemptIssueId: z.string().uuid(),
    authorityDigest: digest,
    rootPath: z.string().min(1),
    cwd: z.string().min(1),
    command: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    maxTurns: z.number().int().min(1).max(100),
    timeoutSec: z.number().int().min(1).max(3600),
    files: z
      .array(
        z
          .object({
            path: relativePath,
            sha256: digest,
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    digest,
  })
  .strict();
export type CoordinatorDeliveryManifest = z.infer<
  typeof coordinatorDeliveryManifestSchema
>;

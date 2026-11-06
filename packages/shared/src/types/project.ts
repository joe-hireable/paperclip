import type { BudgetWindowKind, PauseReason, ProjectStatus } from "../constants.js";
import type {
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspaceRuntimeConfig,
  WorkspaceRuntimeService,
} from "./workspace-runtime.js";
import type { AgentEnvConfig } from "./secrets.js";

export type ProjectWorkspaceSourceType = "local_path" | "git_repo" | "remote_managed" | "non_git_path";
export type ProjectWorkspaceVisibility = "default" | "advanced";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

/**
 * Lightweight per-project budget summary surfaced on the projects list payload
 * (IA Phase 4 — PAP-60). Reflects the active `billed_cents` budget policy scoped
 * to the project, when one is set.
 */
export interface ProjectBudgetSummary {
  /** Budget limit in cents. */
  amountCents: number;
  windowKind: BudgetWindowKind;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string | null;
  cleanupCommand: string | null;
  remoteProvider: string | null;
  remoteWorkspaceRef: string | null;
  sharedWorkspaceKey: string | null;
  metadata: Record<string, unknown> | null;
  runtimeConfig: ProjectWorkspaceRuntimeConfig | null;
  isPrimary: boolean;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectCodebaseOrigin = "local_folder" | "managed_checkout";

export interface ProjectCodebase {
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  repoName: string | null;
  localFolder: string | null;
  managedFolder: string;
  effectiveLocalFolder: string;
  origin: ProjectCodebaseOrigin;
}

export interface ProjectManagedByPlugin {
  id: string;
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  resourceKind: "project";
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  /** Safe visibility only; detailed pins are restricted to the board policy endpoint. */
  coordination?: {
    revision: number;
    configured: boolean;
    executionReady: false;
    readinessReason: "project_archived" | "policy_not_configured" | "coordinator_not_qualified";
  };
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  env: AgentEnvConfig | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  managedByPlugin?: ProjectManagedByPlugin | null;
  /**
   * Number of tasks (issues) in the project. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  taskCount?: number;
  /**
   * Active budget for the project, when set. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  budget?: ProjectBudgetSummary | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Durable project conversation identity; execution qualification is a separate contract. */
export interface ProjectConversation {
  companyId: string;
  projectId: string;
  masterIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeUserId: string | null;
  } | null;
  executionReady: false;
  automaticExecutionConfigured?: boolean;
  readinessReason: "project_archived" | "coordinator_not_qualified";
}


export interface ProjectCoordinationPolicyReadiness {
  companyId: string;
  projectId: string;
  leadAgentId: string | null;
  revision: number;
  policy: import("../validators/project.js").ProjectCoordinationPolicy | null;
  executionReady: false;
  readinessReasons: string[];
}

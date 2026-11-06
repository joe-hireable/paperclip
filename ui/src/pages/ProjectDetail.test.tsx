// @vitest-environment jsdom

import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectConversation } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetail } from "./ProjectDetail";
import { queryKeys } from "../lib/queryKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockProjectsApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listAll: vi.fn(),
  update: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn() }));
const mockExecutionWorkspacesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateProject: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ projectId: "project-1" }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockIssuesList = vi.hoisted(() => vi.fn());
const mockSummarySlotCard = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ projectId: "project-1" }));
const mockLocation = vi.hoisted(() => ({
  pathname: "/projects/project-1/plugin-operations",
  search: "",
}));
const mockCompanyContext = vi.hoisted(() => ({
  companies: [{ id: "company-1", issuePrefix: "PAP" }] as Array<{ id: string; issuePrefix: string }>,
  selectedCompanyId: "company-1" as string | null,
}));
const mockUsePluginSlots = vi.hoisted(() => vi.fn(() => ({ slots: [] as unknown[], isLoading: false })));
const mockPluginSlotMount = vi.hoisted(() => vi.fn());

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: mockExecutionWorkspacesApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("../api/resourceMemberships", () => ({ resourceMembershipsApi: mockResourceMembershipsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useLocation: () => ({ pathname: mockLocation.pathname, search: mockLocation.search, hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockCompanyContext.companies,
    selectedCompanyId: mockCompanyContext.selectedCompanyId,
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: (props: unknown) => {
    mockPluginSlotMount(props);
    return <div data-testid="plugin-slot-mount" />;
  },
  PluginSlotOutlet: () => null,
  usePluginSlots: mockUsePluginSlots,
}));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("../components/ProjectProperties", () => ({
  ProjectProperties: ({ onFieldUpdate }: { onFieldUpdate: (field: string, data: Record<string, unknown>) => void }) => <div data-testid="project-properties"><input aria-label="Unsaved project field" /><button onClick={() => onFieldUpdate("visibility", { visibility: "open" })}>Open project through autosave</button></div>,
}));
vi.mock("../components/BudgetPolicyCard", () => ({
  BudgetPolicyCard: () => <div data-testid="budget-policy-card" />,
}));
vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <span>{value || placeholder || null}</span>
  ),
}));
vi.mock("../components/ProjectWorkspacesContent", () => ({
  ProjectWorkspacesContent: () => <div data-testid="project-workspaces" />,
}));
vi.mock("../components/SummarySlotCard", () => ({
  SummarySlotCard: (props: unknown) => {
    mockSummarySlotCard(props);
    return <div data-testid="summary-slot-card">Project summary card</div>;
  },
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <button key={item.value}>{item.label}</button>)}</div>
  ),
}));
vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: unknown) => {
    mockIssuesList(props);
    return <div data-testid="issues-list" />;
  },
}));

async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Managed Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#14b8a6",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-1",
      effectiveLocalFolder: "/tmp/project-1",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: {
      id: "managed-1",
      pluginId: "plugin-1",
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
      defaultsJson: {},
      createdAt: now,
      updatedAt: now,
    },
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function conversation(overrides: Partial<ProjectConversation> = {}): ProjectConversation {
  return {
    companyId: "company-1",
    projectId: "project-1",
    masterIssue: null,
    executionReady: false,
    readinessReason: "coordinator_not_qualified",
    ...overrides,
  };
}
const masterIssue = { id: "master-1", identifier: "PAP-60", title: "Project conversation", status: "todo", assigneeUserId: "owner-1" };

describe("ProjectDetail", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.projectId = "project-1";
    mockLocation.pathname = "/projects/project-1/plugin-operations";
    mockLocation.search = "";
    mockParams.projectId = "project-1";
    mockCompanyContext.companies = [{ id: "company-1", issuePrefix: "PAP" }];
    mockCompanyContext.selectedCompanyId = "company-1";
    mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: false });
    mockProjectsApi.get.mockResolvedValue(project());
    mockProjectsApi.list.mockResolvedValue([project()]);
    mockProjectsApi.getConversation.mockReset().mockResolvedValue(conversation());
    mockProjectsApi.createConversation.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listAll.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateProject.mockResolvedValue({
      resourceType: "project",
      resourceId: "project-1",
      state: "left",
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it.each(["alias", "other project", "other company"])("preserves a draft only for a same-project route alias (%s)", async target => {
    const loaded = project({ urlKey: "managed-project" });
    mockLocation.pathname = "/projects/project-1/configuration";
    mockProjectsApi.get.mockResolvedValueOnce(loaded);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const render = () => root!.render(<QueryClientProvider client={queryClient}><ProjectDetail /></QueryClientProvider>);
    root = createRoot(container);
    await act(render);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); });
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Unsaved project field"]');
    expect(draft).not.toBeNull();
    draft!.value = "Unsaved repository removal";
    mockProjectsApi.get.mockImplementation(() => new Promise(() => {}));
    mockParams.projectId = target === "other project" ? "different-project" : "managed-project";
    if (target === "other company") mockCompanyContext.selectedCompanyId = "company-2";
    mockLocation.pathname = `/projects/${mockParams.projectId}/configuration`;
    await act(render);
    const after = container.querySelector<HTMLInputElement>('input[aria-label="Unsaved project field"]');
    if (target === "alias") {
      expect(after).toBe(draft);
      expect(after!.value).toBe("Unsaved repository removal");
    } else {
      expect(after).toBeNull();
    }
    await act(() => queryClient.clear());
  });

  it("refreshes cached task audiences when visibility is saved through the field autosave path", async () => {
    mockLocation.pathname = "/projects/project-1/configuration";
    mockProjectsApi.update.mockResolvedValue(project({ visibility: "open" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = queryKeys.issues.accessGrants("cached-task");
    queryClient.setQueryData(key, [{ source: "project" }]);
    root = createRoot(container);
    await act(() => root!.render(<QueryClientProvider client={queryClient}><ProjectDetail /></QueryClientProvider>));
    await settle();
    await act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Open project through autosave")!.click());
    await settle();
    expect(mockProjectsApi.update).toHaveBeenCalledWith("project-1", { visibility: "open" }, "company-1");
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it.each(["issues", "plugin-operations"])("removes cached %s after a real task-list denial", async tab => {
    mockLocation.pathname = `/projects/project-1/${tab}`;
    const read = tab === "issues" ? mockIssuesApi.listAll : mockIssuesApi.list;
    read.mockResolvedValue([{ id: "private-task", companyId: "company-1" }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    try {
      await act(() => root!.render(<QueryClientProvider client={client}><ProjectDetail /></QueryClientProvider>));
      await vi.waitFor(() => expect(mockIssuesList.mock.calls.at(-1)?.[0]).toMatchObject({ issues: [{ id: "private-task" }] }));
      read.mockRejectedValue(new ApiError("forbidden", 403, null));
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.list("company-1") }); });
      await vi.waitFor(() => expect(container.textContent).toContain("You don’t have permission to do that."));
      expect(container.querySelector('[data-testid="issues-list"]')).toBeNull();
    } finally { client.clear(); }
  });

  describe("project conversation", () => {
    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    async function renderDetail(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
      await act(() => {
        root ??= createRoot(container);
        root.render(<QueryClientProvider client={client}><ProjectDetail /></QueryClientProvider>);
      });
      await settle();
      return client;
    }
    async function click(label: string) {
      const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
      expect(button).toBeDefined();
      await act(() => button!.click());
      await settle();
    }

    it("shows loading while the conversation lookup is pending", async () => {
      mockProjectsApi.getConversation.mockReturnValue(new Promise(() => {}));
      await renderDetail();
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading project conversation...");
      expect(container.textContent).not.toContain("Create project conversation");
      expect(mockProjectsApi.createConversation).not.toHaveBeenCalled();
    });

    it("uses company-scoped HTTP reads and an explicit empty create body", async () => {
      const { projectsApi } = await vi.importActual<typeof import("../api/projects")>("../api/projects");
      const { api } = await import("../api/client");
      const get = vi.spyOn(api, "get").mockResolvedValue(conversation());
      const post = vi.spyOn(api, "post").mockResolvedValue(conversation({ masterIssue }));
      try {
        await projectsApi.getConversation("project/id", "company?one");
        await projectsApi.createConversation("project/id", "company?one");
        expect(get).toHaveBeenCalledExactlyOnceWith("/projects/project%2Fid/conversation?companyId=company%3Fone");
        expect(post).toHaveBeenCalledExactlyOnceWith("/projects/project%2Fid/conversation?companyId=company%3Fone", {});
      } finally {
        get.mockRestore();
        post.mockRestore();
      }
    });

    it("loads by canonical project ID without creating on render", async () => {
      const id = "11111111-1111-4111-8111-111111111111";
      mockProjectsApi.get.mockResolvedValue(project({ id }));
      mockProjectsApi.getConversation.mockResolvedValue(conversation({ projectId: id }));
      await renderDetail();
      expect(mockProjectsApi.getConversation).toHaveBeenCalledWith(id, "company-1");
      expect(mockProjectsApi.createConversation).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Create project conversation");
      expect(container.textContent).toContain("Agent coordination is still being set up.");
    });

    it("creates only on click and opens the returned canonical task", async () => {
      mockProjectsApi.createConversation.mockResolvedValue(conversation({ masterIssue }));
      const client = await renderDetail();
      await click("Create project conversation");
      expect(mockProjectsApi.createConversation).toHaveBeenCalledExactlyOnceWith("project-1", "company-1");
      expect(mockNavigate).toHaveBeenCalledWith("/issues/PAP-60");
      expect(client.getQueryData(queryKeys.projects.conversation("company-1", "project-1"))).toEqual(conversation({ masterIssue }));
    });

    it.each([false, true])("opens an existing conversation without creation (archived=%s)", async (archived) => {
      mockProjectsApi.get.mockResolvedValue(project({ archivedAt: archived ? new Date() : null }));
      mockProjectsApi.getConversation.mockResolvedValue(conversation({ masterIssue, readinessReason: archived ? "project_archived" : "coordinator_not_qualified" }));
      await renderDetail();
      expect(container.querySelector('a[href="/issues/PAP-60"]')?.textContent).toBe("Open project conversation");
      expect(container.textContent).not.toContain("Create project conversation");
      expect(mockProjectsApi.createConversation).not.toHaveBeenCalled();
    });

    it("does not offer creation for an archived project without a conversation", async () => {
      mockProjectsApi.get.mockResolvedValue(project({ archivedAt: new Date() }));
      mockProjectsApi.getConversation.mockResolvedValue(conversation({ readinessReason: "project_archived" }));
      await renderDetail();
      expect(container.textContent).toContain("Archived projects cannot start a conversation.");
      expect(container.textContent).not.toContain("Create project conversation");
    });

    it("shows a read error and retries without creating", async () => {
      mockProjectsApi.getConversation.mockRejectedValueOnce(new Error("Unavailable"));
      await renderDetail();
      expect(container.textContent).toContain("Could not load the project conversation.");
      await click("Retry");
      expect(mockProjectsApi.getConversation).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Create project conversation");
      expect(mockProjectsApi.createConversation).not.toHaveBeenCalled();
    });

    it("keeps failed creation visible and requires another explicit click", async () => {
      mockProjectsApi.createConversation.mockRejectedValueOnce(new Error("Unavailable"));
      await renderDetail();
      await click("Create project conversation");
      expect(container.textContent).toContain("Could not create the project conversation.");
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockProjectsApi.createConversation).toHaveBeenCalledTimes(1);
      mockProjectsApi.createConversation.mockResolvedValue(conversation({ masterIssue }));
      await click("Create project conversation");
      expect(mockNavigate).toHaveBeenCalledWith("/issues/PAP-60");
    });

    it.each(["company", "project"])("keeps a late creation on its original cache and does not navigate after a %s switch", async (switchKind) => {
      let resolveCreation!: (value: ProjectConversation) => void;
      mockProjectsApi.createConversation.mockReturnValue(new Promise<ProjectConversation>((resolve) => { resolveCreation = resolve; }));
      const client = await renderDetail();
      await click("Create project conversation");
      expect(mockProjectsApi.createConversation).toHaveBeenCalledTimes(1);
      const nextCompany = switchKind === "company" ? "company-2" : "company-1";
      const nextProject = switchKind === "project" ? "project-2" : "project-1";
      mockCompanyContext.selectedCompanyId = nextCompany;
      mockParams.projectId = nextProject;
      mockLocation.pathname = `/projects/${nextProject}/plugin-operations`;
      mockProjectsApi.get.mockResolvedValue(project({ id: nextProject, urlKey: nextProject, companyId: nextCompany }));
      mockProjectsApi.getConversation.mockResolvedValue(conversation({ companyId: nextCompany, projectId: nextProject }));
      await renderDetail(client);
      mockNavigate.mockClear();
      await act(() => resolveCreation(conversation({ masterIssue })));
      await settle();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(client.getQueryData(queryKeys.projects.conversation("company-1", "project-1"))).toEqual(conversation({ masterIssue }));
      expect(client.getQueryData(queryKeys.projects.conversation(nextCompany, nextProject))).toEqual(conversation({ companyId: nextCompany, projectId: nextProject }));
      expect(container.querySelector('a[href="/issues/PAP-60"]')).toBeNull();
    });
  });

  it("shows managed plugin affordances and filters the operations tab by plugin origin", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Managed by Missions");
    expect(container.textContent).toContain("Project summary card");
    expect(mockSummarySlotCard).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      scopeKind: "project",
      scopeId: "project-1",
      title: "Project summary",
    }));
    const titleEditor = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "Managed Project");
    const summaryCard = container.querySelector('[data-testid="summary-slot-card"]');
    expect(titleEditor && summaryCard ? Boolean(titleEditor.compareDocumentPosition(summaryCard) & Node.DOCUMENT_POSITION_FOLLOWING) : false).toBe(true);
    expect(container.textContent).toContain("Plugin operations");
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
      originKindPrefix: "plugin:paperclip.missions",
    });
  });

  it("keeps Timeline out of the project task-list controls", async () => {
    mockLocation.pathname = "/projects/project-1/issues";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const props = mockIssuesList.mock.calls.at(-1)?.[0];
    expect(props).toEqual(expect.objectContaining({ projectId: "project-1" }));
    expect(props).not.toHaveProperty("projectTimelineHref");
  });

  describe("plugin detail-tab deep links", () => {
    const PLUGIN_TAB = "plugin:paperclipai.plugin-llm-wiki:project-knowledge";
    const knowledgeSlot = {
      id: "project-knowledge",
      type: "detailTab",
      displayName: "Knowledge",
      entityTypes: ["project"],
      pluginId: "plugin-llm-wiki",
      pluginKey: "paperclipai.plugin-llm-wiki",
      pluginDisplayName: "LLM Wiki",
      pluginVersion: "0.2.0",
    };

    async function renderDetail() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root = createRoot(container);
        root.render(
          <QueryClientProvider client={queryClient}>
            <ProjectDetail />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("keeps a cold deep link on the plugin tab while contributions are still loading", async () => {
      mockLocation.pathname = "/projects/project-1";
      mockLocation.search = `?tab=${encodeURIComponent(PLUGIN_TAB)}`;
      mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: true });

      await renderDetail();

      expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    });

    it("does not bounce to the issues tab before the company for the slots query resolves", async () => {
      // Cold reload race: the slots query is disabled until a company is
      // known, and a disabled query reports isLoading=false.
      mockLocation.pathname = "/projects/project-1";
      mockLocation.search = `?tab=${encodeURIComponent(PLUGIN_TAB)}`;
      mockCompanyContext.companies = [];
      mockCompanyContext.selectedCompanyId = null;
      mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: false });

      await renderDetail();

      expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    });

    it("renders the registered plugin tab for a direct deep link", async () => {
      mockLocation.pathname = "/projects/project-1";
      mockLocation.search = `?tab=${encodeURIComponent(PLUGIN_TAB)}`;
      mockUsePluginSlots.mockReturnValue({ slots: [knowledgeSlot], isLoading: false });

      await renderDetail();

      expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')).not.toBeNull();
      expect(mockPluginSlotMount).toHaveBeenCalledWith(expect.objectContaining({
        slot: expect.objectContaining({ id: "project-knowledge", pluginKey: "paperclipai.plugin-llm-wiki" }),
      }));
      expect(container.textContent).toContain("Knowledge");
    });

    it("falls back to the issues tab once contributions load without the requested tab", async () => {
      mockLocation.pathname = "/projects/project-1";
      mockLocation.search = `?tab=${encodeURIComponent(PLUGIN_TAB)}`;
      mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: false });

      await renderDetail();

      expect(container.querySelector('[data-testid="navigate"]')?.textContent)
        .toBe("/projects/project-1/issues");
    });
  });
});

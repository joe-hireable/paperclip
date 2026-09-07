import type {
  ExecutionBinding,
  ExecutionBindingDefinition,
  ExecutionBindingSnapshot,
} from "@paperclipai/shared/execution-bindings";
import { api } from "./client";

export const executionBindingsApi = {
  list: (companyId: string) =>
    api.get<ExecutionBinding[]>(`/companies/${companyId}/execution-bindings`),
  create: (companyId: string, definition: ExecutionBindingDefinition) =>
    api.post<ExecutionBinding>(
      `/companies/${companyId}/execution-bindings`,
      definition,
    ),
  disable: (companyId: string, bindingId: string) =>
    api.post<ExecutionBinding>(
      `/companies/${companyId}/execution-bindings/${bindingId}/disable`,
      {},
    ),
  forRun: (companyId: string, runId: string) =>
    api.get<{
      snapshot: ExecutionBindingSnapshot;
      releasedAt: Date | null;
      releaseReason: string | null;
    } | null>(`/companies/${companyId}/runs/${runId}/execution-binding`),
};

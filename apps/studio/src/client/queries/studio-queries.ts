import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createStudioThread,
  deleteStudioThread,
  fetchStudioCatalog,
  fetchStudioConnection,
  fetchStudioMeta,
  fetchStudioModelLabel,
  fetchStudioThreadMessages,
  fetchStudioThreads,
  renameStudioThread,
} from "../api/studio-api";

export const studioQueryKeys = {
  catalog: ["studio", "catalog"] as const,
  connection: ["studio", "connection"] as const,
  meta: ["studio", "meta"] as const,
  model: ["studio", "model"] as const,
  threadMessages: (threadId: string) => ["studio", "threads", threadId, "messages"] as const,
  threads: ["studio", "threads"] as const,
};

export function useStudioWorkspaceQueries() {
  return {
    catalog: useQuery({
      queryKey: studioQueryKeys.catalog,
      queryFn: ({ signal }) => fetchStudioCatalog({ signal }),
      staleTime: 30_000,
    }),
    connection: useQuery({
      queryKey: studioQueryKeys.connection,
      queryFn: ({ signal }) => fetchStudioConnection(signal),
      refetchInterval: 60_000,
      staleTime: 30_000,
    }),
    meta: useQuery({
      queryKey: studioQueryKeys.meta,
      queryFn: ({ signal }) => fetchStudioMeta(signal),
      staleTime: Infinity,
    }),
    model: useQuery({
      queryKey: studioQueryKeys.model,
      queryFn: ({ signal }) => fetchStudioModelLabel(signal),
      staleTime: 60_000,
    }),
  };
}

export function useStudioThreadsQuery() {
  return useQuery({
    queryKey: studioQueryKeys.threads,
    queryFn: ({ signal }) => fetchStudioThreads(signal),
    staleTime: 10_000,
  });
}

export function useStudioThreadMessagesQuery(threadId: string | undefined) {
  return useQuery({
    enabled: Boolean(threadId),
    queryKey: studioQueryKeys.threadMessages(threadId ?? "pending"),
    queryFn: ({ signal }) => fetchStudioThreadMessages(threadId as string, signal),
    staleTime: 0,
  });
}

export function useStudioThreadMutations() {
  const queryClient = useQueryClient();
  const invalidateThreads = () => queryClient.invalidateQueries({ queryKey: studioQueryKeys.threads });

  return {
    create: useMutation({
      mutationFn: () => createStudioThread(),
      onSuccess: () => invalidateThreads(),
    }),
    remove: useMutation({
      mutationFn: (threadId: string) => deleteStudioThread(threadId),
      onSuccess: (_data, threadId) => {
        void invalidateThreads();
        queryClient.removeQueries({ queryKey: studioQueryKeys.threadMessages(threadId) });
      },
    }),
    rename: useMutation({
      mutationFn: ({ threadId, title }: { threadId: string; title: string }) => renameStudioThread(threadId, title),
      onSuccess: () => invalidateThreads(),
    }),
  };
}

export function useRefreshStudioWorkspace() {
  const queryClient = useQueryClient();
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: studioQueryKeys.connection }),
    queryClient.invalidateQueries({ queryKey: studioQueryKeys.catalog }),
    queryClient.invalidateQueries({ queryKey: studioQueryKeys.model }),
  ]);
}

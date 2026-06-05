import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Circle,
  Database,
  FileText,
  Folder,
  Hammer,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Send,
  Settings,
  Shield,
  Square,
  Terminal,
  Trash2,
  User,
  X,
} from "lucide-react";
import type {
  EgressHandlerInfo,
  ContainerSummary,
  Model,
  ProviderInfo,
  ProviderModelInfo,
  SessionListResponse,
  SessionResponse,
  SessionSummary,
  WorkspaceProvider,
} from "@clawflare/types";
import { z } from "zod";
import { ApiError, ClawflareApiClient } from "./lib/api";
import {
  applyAssistantPartialEvents,
  attachToolResults,
  formatMessageForDisplay,
  formatMessagesFromEvents,
  formatSessionTitle,
  formatToolCallHeader,
  getEventDisplayMessage,
  type DisplayMessage,
  type ToolCallInfo,
} from "./lib/format";
import { loadSettings, saveSettings, type AppSettings } from "./lib/settings";

type AppPage = "chat" | "settings";
type SettingsSection = "providers" | "egress" | "models" | "account" | "data";
type LoginStatus = "idle" | "starting" | "waiting" | "approved" | "error";

interface SelectedContainer {
  sessionId: string;
  containerId: string;
}

interface ContainerFileLink {
  containerId: string;
  path: string;
}

interface ContainerDirEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  mode: string | null;
  mtime: string | null;
  depth: number;
}

interface ContainerLsDetails {
  ok: boolean;
  path: string;
  entries: ContainerDirEntry[];
  entryCount: number;
  truncated: boolean;
}

interface ContainerReadDetails {
  ok: boolean;
  path: string;
  totalLines: number;
  size: number;
}

interface ContainerFindResult {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string | null;
}

interface QuickPromptFileResult extends ContainerFindResult {
  sessionId: string;
  containerId: string;
}

interface ContainerFindDetails {
  ok: boolean;
  path: string;
  results: ContainerFindResult[];
  resultCount: number;
  truncated: boolean;
}

interface ContainerFile {
  path: string;
  content?: string;
  dataUrl?: string;
  mimeType?: string;
  kind: "text" | "image";
  totalLines: number;
  size: number;
}

interface ContainerBashDetails {
  ok?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
  killed?: boolean;
}

type QuickPromptCommandId =
  | "open-file"
  | "open-directory"
  | "open-container"
  | "open-session"
  | "rename-session"
  | "rename-container";

interface QuickPromptCommandDefinition {
  id: QuickPromptCommandId;
  prefix: string;
  aliases?: string[];
  detail: string;
}

const quickPromptCommands: readonly QuickPromptCommandDefinition[] = [
  { id: "open-file", prefix: "Open File: ", detail: "Open a file in the selected container" },
  { id: "open-directory", prefix: "Open Directory: ", detail: "Open a directory in the selected container" },
  { id: "open-container", prefix: "Open Container: ", detail: "Open a container workspace" },
  { id: "open-session", prefix: "Open Session: ", detail: "Open a session" },
  { id: "rename-session", prefix: "Rename Session: ", aliases: ["rename", "name"], detail: "Rename the current session" },
  { id: "rename-container", prefix: "Rename Container: ", detail: "Rename a container" },
] as const;

type QuickPromptItem =
  | {
      id: string;
      kind: "file";
      label: string;
      detail: string;
      sessionId: string;
      containerId: string;
      path: string;
      fileType: "file" | "directory";
    }
  | {
      id: string;
      kind: "container";
      label: string;
      detail: string;
      sessionId: string;
      containerId: string;
    }
  | {
      id: string;
      kind: "session";
      label: string;
      detail: string;
      sessionId: string;
    }
  | {
      id: string;
      kind: "prompt";
      label: string;
      detail: string;
      prompt: string;
    }
  | {
      id: string;
      kind: "command";
      label: string;
      detail: string;
      command: QuickPromptCommandId;
      argument: string;
      sessionId?: string;
      containerId?: string;
    };

const settingsSectionIds: SettingsSection[] = ["providers", "egress", "models", "account", "data"];
const DEFAULT_CONTAINER_SLEEP_AFTER_MS = 20 * 60 * 1000;

function sessionIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

type ContainerRouteEntry = { containerId: string; path: string; fileType: "file" | "directory" };

function containerEntryFromLocation(): ContainerRouteEntry | null {
  const match = window.location.pathname.match(/^\/containers\/([^/]+)\/(files|directories)(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  const fileType = match[2] === "directories" ? "directory" : "file";
  const path = normalizeQuickFilePath(decodeURIComponent(match[3] ?? ""));
  return {
    containerId: decodeURIComponent(match[1]),
    fileType,
    path: path || (fileType === "directory" ? "." : ""),
  };
}

function settingsSectionFromLocation(): SettingsSection | null {
  const match = window.location.pathname.match(/^\/settings(?:\/([^/]+))?$/);
  if (!match) return null;
  const section = match[1];
  if (!section) return "providers";
  return settingsSectionIds.includes(section as SettingsSection) ? (section as SettingsSection) : "providers";
}

function updateBrowserSessionPath(sessionId: string, mode: "push" | "replace" = "push"): void {
  const path = `/session/${encodeURIComponent(sessionId)}`;
  if (window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({ sessionId }, "", path);
}

function updateBrowserContainerEntryPath(
  containerId: string,
  path: string,
  fileType: "file" | "directory",
  mode: "push" | "replace" = "push",
): void {
  const normalizedPath = normalizeQuickFilePath(path);
  const encodedPath = normalizedPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const entryType = fileType === "directory" ? "directories" : "files";
  const urlPath = `/containers/${encodeURIComponent(containerId)}/${entryType}${encodedPath ? `/${encodedPath}` : ""}`;
  if (window.location.pathname === urlPath) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({ containerId, path: normalizedPath, fileType }, "", urlPath);
}

function updateBrowserSettingsPath(section: SettingsSection | null = null, mode: "push" | "replace" = "push"): void {
  const path = section ? `/settings/${section}` : "/settings";
  if (window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({ section }, "", path);
}

function updateBrowserRootPath(mode: "push" | "replace" = "push"): void {
  if (window.location.pathname === "/") return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", "/");
}

const providerFormSchema = z.object({
  provider: z.string().min(1),
  modelName: z.string().min(1),
  secrets: z.record(z.string()),
});

const egressFormSchema = z.object({
  egressHandlerId: z.string().min(1),
  enabled: z.boolean(),
  secrets: z.record(z.string()),
  config: z.record(z.unknown()),
});

function App(): JSX.Element {
  const queryClient = useQueryClient();
  const initialSettingsSection = settingsSectionFromLocation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle");
  const [loginMessage, setLoginMessage] = useState("");
  const [loginUser, setLoginUser] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [promptHistory, setPromptHistory] = useState<SessionResponse["promptHistory"] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [statusText, setStatusText] = useState("Disconnected");
  const [isRunning, setIsRunning] = useState(false);
  const [serverProcessingSessionId, setServerProcessingSessionId] = useState<string | null>(null);
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appPage, setAppPage] = useState<AppPage>(initialSettingsSection ? "settings" : "chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSettingsSection ?? "providers");
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<SelectedContainer | null>(null);
  const [containerPath, setContainerPath] = useState(".");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [quickPromptQuery, setQuickPromptQuery] = useState("");
  const [quickPromptSelectedIndex, setQuickPromptSelectedIndex] = useState(0);
  const [containerClock, setContainerClock] = useState(() => Date.now());
  const [selectedProvider, setSelectedProvider] = useState("");
  const [showModelForm, setShowModelForm] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelSecrets, setModelSecrets] = useState<Record<string, string>>({});
  const [selectedEgress, setSelectedEgress] = useState("");
  const [showEgressForm, setShowEgressForm] = useState(false);
  const [egressSecrets, setEgressSecrets] = useState<Record<string, string>>({});
  const [egressConfig, setEgressConfig] = useState<Record<string, string>>({});
  const [egressEnabled, setEgressEnabled] = useState(true);
  const [composerRows, setComposerRows] = useState(2);
  const abortController = useRef<AbortController | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const abortingSessionIdRef = useRef<string | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickPromptInputRef = useRef<HTMLInputElement | null>(null);
  const messageScrollerRef = useRef<HTMLElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const pendingPromptFocusRef = useRef(false);
  const oldestLoadedEventSequenceRef = useRef<number | null>(null);
  const historyLoadingRef = useRef(false);
  const latestEventCursorRef = useRef<string | null>(null);
  const followingSessionRef = useRef<string | null>(null);
  const followingAbortControllerRef = useRef<AbortController | null>(null);
  const restoreScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const loginWindowRef = useRef<Window | null>(null);
  const initialPathSessionRef = useRef<string | null>(null);

  const client = useMemo(
    () => new ClawflareApiClient(settings.serverUrl, settings.token),
    [settings.serverUrl, settings.token],
  );
  const isConfigured = Boolean(settings.token);

  useEffect(() => {
    const timer = window.setInterval(() => setContainerClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currentUser = useQuery({
    queryKey: ["current-user", settings.serverUrl, settings.token],
    queryFn: () => client.getCurrentUser(),
    enabled: isConfigured,
  });
  const hasInvalidAuth = currentUser.error instanceof ApiError && currentUser.error.status === 401;
  const hasUsableAuth = isConfigured && !hasInvalidAuth;

  const sessions = useQuery({
    queryKey: ["sessions", settings.serverUrl, settings.token],
    queryFn: () => client.listSessions({ status: "all", limit: 80 }),
    enabled: hasUsableAuth,
    refetchInterval: (query) => {
      const activeSession = query.state.data?.sessions.find((session) => session.id === sessionId);
      return isRunning || serverProcessingSessionId === sessionId || activeSession?.status === "processing" ? 2000 : 15_000;
    },
  });

  const containerListing = useQuery({
    queryKey: ["container-ls", settings.serverUrl, settings.token, selectedContainer?.sessionId, selectedContainer?.containerId, containerPath],
    queryFn: async () => {
      if (!selectedContainer) throw new Error("No container selected");
      const response = await client.invokeTool<ContainerLsDetails>(selectedContainer.sessionId, "container_ls", {
        containerId: selectedContainer.containerId,
        path: containerPath,
        maxResults: 500,
      });
      if (!response.result.details) throw new Error("Container listing did not include details");
      return response.result.details;
    },
    enabled: hasUsableAuth && Boolean(selectedContainer),
  });

  const selectedFile = useQuery({
    queryKey: ["container-read", settings.serverUrl, settings.token, selectedContainer?.sessionId, selectedContainer?.containerId, selectedFilePath],
    queryFn: async (): Promise<ContainerFile> => {
      if (!selectedContainer || !selectedFilePath) throw new Error("No file selected");
      const imageMimeType = imageMimeTypeFromPath(selectedFilePath);
      if (imageMimeType) {
        const escapedPath = shellSingleQuote(selectedFilePath);
        const response = await client.invokeTool<ContainerBashDetails>(selectedContainer.sessionId, "container_bash", {
          containerId: selectedContainer.containerId,
          command: `base64 ${escapedPath} | tr -d '\\n'`,
          cwd: ".",
          maxOutputChars: 8_000_000,
        });
        const base64 = extractBashStdout(response.result.content?.find((part) => part.type === "text")?.text ?? "").trim();
        if (response.result.details?.ok === false || response.result.details?.exitCode) {
          throw new Error(base64 || `Failed to load image ${selectedFilePath}`);
        }
        return {
          path: selectedFilePath,
          dataUrl: `data:${imageMimeType};base64,${base64}`,
          mimeType: imageMimeType,
          kind: "image",
          totalLines: 0,
          size: Math.floor(base64.length * 0.75),
        };
      }

      const response = await client.invokeTool<ContainerReadDetails>(selectedContainer.sessionId, "container_read", {
        containerId: selectedContainer.containerId,
        path: selectedFilePath,
        maxBytes: 500_000,
      });
      const details = response.result.details;
      const text = response.result.content?.find((part) => part.type === "text")?.text ?? "";
      const content = text.startsWith(`--- ${selectedFilePath} ---\n`)
        ? text.slice(`--- ${selectedFilePath} ---\n`.length)
        : text.replace(/^--- .* ---\n/, "");
      return {
        path: details?.path ?? selectedFilePath,
        content,
        kind: "text",
        totalLines: details?.totalLines ?? content.split("\n").length,
        size: details?.size ?? content.length,
      };
    },
    enabled: hasUsableAuth && Boolean(selectedContainer && selectedFilePath),
  });

  const currentSession = sessions.data?.sessions.find((session) => session.id === sessionId);
  const selectedContainerSession = selectedContainer
    ? sessions.data?.sessions.find((session) => session.id === selectedContainer.sessionId)
    : undefined;
  const selectedContainerSummary = selectedContainer && selectedContainerSession
    ? allSessionContainers(selectedContainerSession).find((container) => container.id === selectedContainer.containerId)
    : undefined;
  const currentContainerIds = useMemo(
    () => (
      sessionId
        ? mergeContainers(
            currentSession ? activeSessionContainerIds(currentSession) : [],
            inferContainerIds(sessionId, messages),
          )
        : []
    ),
    [currentSession, messages, sessionId],
  );
  const quickPromptContainers = useMemo(
    () => (sessionId ? currentContainerIds.map((containerId) => ({ sessionId, containerId })) : []),
    [currentContainerIds, sessionId],
  );
  const quickFileSearchQuery = quickPromptOpen ? quickPromptFileSearchQuery(quickPromptQuery) : "";
  const debouncedQuickFileSearchQuery = useDebouncedValue(quickFileSearchQuery, 150);
  const quickFiles = useQuery({
    queryKey: [
      "container-find-paths",
      settings.serverUrl,
      settings.token,
      sessionId,
      currentContainerIds,
      debouncedQuickFileSearchQuery,
    ],
    queryFn: async (): Promise<QuickPromptFileResult[]> => {
      if (quickPromptContainers.length === 0) throw new Error("No containers selected");
      const search = containerFindSearchInput(debouncedQuickFileSearchQuery);
      const results = await Promise.all(
        quickPromptContainers.map(async (container) => {
          try {
            const response = await client.invokeTool<ContainerFindDetails>(container.sessionId, "container_find", {
              containerId: container.containerId,
              path: search.path,
              ...(search.name ? { name: search.name } : {}),
              type: "any",
              maxResults: 1000,
            });
            return (response.result.details?.results ?? []).map((file) => ({
              ...file,
              sessionId: container.sessionId,
              containerId: container.containerId,
            }));
          } catch {
            return [];
          }
        }),
      );
      return results.flat();
    },
    enabled: hasUsableAuth && quickPromptContainers.length > 0,
    placeholderData: (previous) => previous ?? [],
    refetchOnWindowFocus: false,
  });
  const quickFileMatches = useMemo(
    () => filterQuickFiles(quickFiles.data ?? [], debouncedQuickFileSearchQuery),
    [debouncedQuickFileSearchQuery, quickFiles.data],
  );
  const quickPromptItems = useMemo(
    () => buildQuickPromptItems({
      query: quickPromptQuery,
      sessions: sessions.data?.sessions ?? [],
      currentSessionId: sessionId,
      containers: quickPromptContainers,
      files: quickFileMatches,
    }),
    [quickFileMatches, quickPromptContainers, quickPromptQuery, sessionId, sessions.data?.sessions],
  );

  const providers = useQuery({
    queryKey: ["providers", settings.serverUrl, settings.token],
    queryFn: () => client.listProviders(),
    enabled: hasUsableAuth && appPage === "settings",
  });

  const workspaceProviders = useQuery({
    queryKey: ["workspace-providers", settings.serverUrl, settings.token],
    queryFn: async () => {
      const startedAt = performance.now();
      try {
        const providers = await client.listConfiguredProviders();
        console.info("[clawflare-web-timing] workspace providers loaded", {
          elapsedMs: Math.round(performance.now() - startedAt),
          providerCount: providers.length,
        });
        return providers;
      } catch (cause) {
        console.warn("[clawflare-web-timing] workspace providers failed", {
          elapsedMs: Math.round(performance.now() - startedAt),
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },
    enabled: hasUsableAuth,
  });

  const providerModels = useQuery({
    queryKey: ["provider-models", settings.serverUrl, settings.token, selectedProvider],
    queryFn: () => client.listProviderModels(selectedProvider),
    enabled: hasUsableAuth && appPage === "settings" && Boolean(selectedProvider),
  });

  const models = useQuery({
    queryKey: ["models", settings.serverUrl, settings.token],
    queryFn: () => client.listModels(),
    enabled: hasUsableAuth && appPage === "settings",
  });

  const availableEgress = useQuery({
    queryKey: ["available-egress", settings.serverUrl, settings.token],
    queryFn: () => client.listAvailableEgressHandlers(),
    enabled: hasUsableAuth && appPage === "settings",
  });

  const configuredEgress = useQuery({
    queryKey: ["egress", settings.serverUrl, settings.token],
    queryFn: () => client.listEgressHandlers({ enabledOnly: false }),
    enabled: hasUsableAuth && appPage === "settings",
  });

  const renameSession = useMutation({
    mutationFn: (name: string) => client.renameSession(sessionId, name),
    onSuccess: () => {
      setStatusText("Session renamed");
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: showError,
  });

  const renameContainer = useMutation({
    mutationFn: ({ containerId, name }: { containerId: string; name: string }) => client.renameContainer(containerId, name),
    onSuccess: (result) => {
      setStatusText(`Container renamed to ${result.name}`);
      queryClient.setQueryData(
        ["sessions", settings.serverUrl, settings.token],
        (current: SessionListResponse | undefined) => current
          ? {
              ...current,
              sessions: current.sessions.map((session) => {
                if (!allSessionContainers(session).some((container) => container.id === result.container.id)) return session;
                return {
                  ...session,
                  containerDetails: allSessionContainers(session).map((container) => (
                    container.id === result.container.id ? result.container : container
                  )),
                };
              }),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: showError,
  });

  const killSession = useMutation({
    mutationFn: (targetSessionId: string) => client.killSession(targetSessionId),
    onSuccess: (result) => {
      if (result.sessionId === sessionId) {
        abortRun();
      }
      setStatusText(result.workflowTerminated ? "Session killed" : "Session closed");
      setMessages((current) => [
        ...current,
        {
          role: result.ok ? "assistant" : "error",
          content: formatKillResult(result),
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: showError,
  });

  const deleteSession = useMutation({
    mutationFn: (targetSessionId: string) => client.deleteSession(targetSessionId),
    onSuccess: (result) => {
      if (result.sessionId === sessionId) {
        abortRun();
        setSessionId("");
        setMessages([]);
        setPromptHistory(null);
        resetHistoryState();
        updateBrowserRootPath("replace");
      }
      setStatusText(result.ok ? "Session deleted" : "Session deleted with cleanup errors");
      setMessages((current) => [
        ...current,
        {
          role: result.ok ? "assistant" : "error",
          content: formatDeleteResult(result),
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: showError,
  });

  const addProvider = useMutation({
    mutationFn: () => {
      const parsed = providerFormSchema.parse({
        provider: selectedProvider,
        modelName: selectedModel,
        secrets: pruneEmpty(modelSecrets),
      });
      return client.createProvider({
        provider: parsed.provider,
        secrets: parsed.secrets,
        defaultModelName: parsed.modelName,
        createDefaultModel: true,
        setAsDefault: true,
      });
    },
    onSuccess: (result) => {
      setModelSecrets({});
      setShowModelForm(false);
      setStatusText("Provider configured");
      queryClient.setQueryData(
        ["workspace-providers", settings.serverUrl, settings.token],
        (current: WorkspaceProvider[] | undefined) => {
          const providers = current ?? [];
          const filtered = providers.filter((provider) => provider.id !== result.provider.id);
          return [result.provider, ...filtered];
        },
      );
      if (result.model) {
        queryClient.setQueryData(
          ["models", settings.serverUrl, settings.token],
          (current: { models: Model[]; defaultModelId?: string } | undefined) => {
            const models = current?.models ?? [];
            const filtered = models.filter((model) => model.id !== result.model!.id);
            return {
              models: [result.model!, ...filtered],
              defaultModelId: result.defaultModelId ?? current?.defaultModelId,
            };
          },
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["workspace-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      void workspaceProviders.refetch();
      void models.refetch();
    },
    onError: showError,
  });

  const deleteModel = useMutation({
    mutationFn: (id: string) => client.deleteModel(id),
    onSuccess: () => {
      setStatusText("Model removed");
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: showError,
  });

  const deleteProvider = useMutation({
    mutationFn: (id: string) => client.deleteProvider(id),
    onSuccess: (result) => {
      setStatusText("Provider removed");
      queryClient.setQueryData(
        ["workspace-providers", settings.serverUrl, settings.token],
        (current: WorkspaceProvider[] | undefined) => (current ?? []).filter((provider) => provider.id !== result.providerId),
      );
      queryClient.setQueryData(
        ["models", settings.serverUrl, settings.token],
        (current: { models: Model[]; defaultModelId?: string } | undefined) => {
          if (!current) return current;
          const deleted = new Set(result.deletedModelIds);
          return {
            models: current.models.filter((model) => !deleted.has(model.id)),
            defaultModelId: result.clearedDefaultModelId === current.defaultModelId ? undefined : current.defaultModelId,
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ["workspace-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: showError,
  });

  const setDefaultModel = useMutation({
    mutationFn: (id: string | null) => client.setDefaultModel(id),
    onSuccess: () => {
      setStatusText("Default model updated");
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: showError,
  });

  const configureEgress = useMutation({
    mutationFn: () => {
      const parsed = egressFormSchema.parse({
        egressHandlerId: selectedEgress,
        enabled: egressEnabled,
        secrets: pruneEmpty(egressSecrets),
        config: pruneEmpty(egressConfig),
      });
      return client.configureEgressHandler(parsed);
    },
    onSuccess: () => {
      setEgressSecrets({});
      setEgressConfig({});
      setShowEgressForm(false);
      setStatusText("Egress handler configured");
      void queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: showError,
  });

  const updateEgress = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => client.updateEgressHandler(id, { enabled }),
    onSuccess: () => {
      setStatusText("Egress handler updated");
      void queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: showError,
  });

  const deleteEgress = useMutation({
    mutationFn: (id: string) => client.deleteEgressHandler(id),
    onSuccess: () => {
      setStatusText("Egress handler removed");
      void queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: showError,
  });

  const activeSessionIsProcessing = currentSession?.status === "processing" || serverProcessingSessionId === sessionId;
  const activeSessionIsStopping = Boolean(stoppingSessionId && stoppingSessionId === sessionId && activeSessionIsProcessing);
  const composerBusy = isRunning || activeSessionIsProcessing;
  const checkingProviderSetup = hasUsableAuth && workspaceProviders.isPending;
  const needsProviderSetup = hasUsableAuth && (workspaceProviders.data?.length ?? 0) === 0 && !workspaceProviders.isPending;

  function scrollMessagesToBottom(): void {
    const scroller = messageScrollerRef.current;
    if (!scroller) {
      messageEndRef.current?.scrollIntoView({ block: "end" });
      return;
    }

    const scroll = (): void => {
      if (!shouldStickToBottomRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    };
    scroll();
    window.requestAnimationFrame(() => {
      scroll();
      window.requestAnimationFrame(scroll);
    });
  }

  useLayoutEffect(() => {
    const restore = restoreScrollRef.current;
    if (restore) {
      const scroller = messageScrollerRef.current;
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight - restore.scrollHeight + restore.scrollTop;
      }
      restoreScrollRef.current = null;
      return;
    }
    if (shouldStickToBottomRef.current) {
      scrollMessagesToBottom();
    }
  }, [messages, composerBusy, promptHistory]);

  useLayoutEffect(() => {
    if (!pendingPromptFocusRef.current) return;
    if (appPage !== "chat" || selectedContainer || quickPromptOpen || !hasUsableAuth || checkingProviderSetup || needsProviderSetup) return;
    focusPromptNow();
  }, [appPage, checkingProviderSetup, hasUsableAuth, needsProviderSetup, quickPromptOpen, selectedContainer, sessionId]);

  useEffect(() => {
    if (!hasUsableAuth) return;
    const pathContainerEntry = containerEntryFromLocation();
    if (pathContainerEntry) {
      if (!sessions.data) return;
      if (
        selectedContainer?.containerId === pathContainerEntry.containerId
        && (
          pathContainerEntry.fileType === "file"
            ? selectedFilePath === pathContainerEntry.path
            : !selectedFilePath && containerPath === pathContainerEntry.path
        )
      ) {
        return;
      }
      openContainerEntryRoute(pathContainerEntry, { history: "replace" });
      return;
    }
    const pathSessionId = sessionIdFromLocation();
    if (!pathSessionId || pathSessionId === sessionId || initialPathSessionRef.current === pathSessionId) return;
    initialPathSessionRef.current = pathSessionId;
    void openSession(pathSessionId, { history: "replace" });
  }, [containerPath, hasUsableAuth, selectedContainer?.containerId, selectedFilePath, sessions.data, settings.serverUrl, settings.token]);

  useEffect(() => {
    const onPopState = (): void => {
      const pathSettingsSection = settingsSectionFromLocation();
      if (pathSettingsSection) {
        setAppPage("settings");
        setSettingsSection(pathSettingsSection);
        return;
      }
      const pathContainerEntry = containerEntryFromLocation();
      if (pathContainerEntry) {
        openContainerEntryRoute(pathContainerEntry, { history: "replace" });
        return;
      }
      const pathSessionId = sessionIdFromLocation();
      if (pathSessionId) {
        void openSession(pathSessionId, { history: "replace" });
        return;
      }
      startDraftSession({ history: "replace" });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  useEffect(() => {
    const firstProvider = providers.data?.[0]?.id;
    if (!selectedProvider && firstProvider) setSelectedProvider(firstProvider);
  }, [providers.data, selectedProvider]);

  useEffect(() => {
    const firstModel = providerModels.data?.[0]?.id;
    if (!providerModels.data?.some((model) => model.id === selectedModel)) {
      setSelectedModel(firstModel ?? "");
    }
  }, [providerModels.data, selectedModel]);

  useEffect(() => {
    const first = availableEgress.data?.[0]?.egressHandlerId;
    if (!selectedEgress && first) setSelectedEgress(first);
  }, [availableEgress.data, selectedEgress]);

  useEffect(() => {
    if (currentSession && currentSession.id === serverProcessingSessionId && currentSession.status !== "processing") {
      setServerProcessingSessionId(null);
    }
    if (currentSession && currentSession.id === stoppingSessionId && currentSession.status !== "processing") {
      setStoppingSessionId(null);
      if (abortingSessionIdRef.current === currentSession.id) abortingSessionIdRef.current = null;
    }
  }, [currentSession, serverProcessingSessionId, stoppingSessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "p" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntryElement(document.activeElement)) return;

      event.preventDefault();
      openQuickPrompt();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setQuickPromptSelectedIndex(0);
  }, [quickPromptQuery, quickPromptOpen, selectedContainer?.containerId, sessions.data]);

  useEffect(() => {
    const cause = containerListing.error ?? selectedFile.error ?? quickFiles.error;
    if (cause) showError(cause);
  }, [containerListing.error, quickFiles.error, selectedFile.error]);

  useEffect(() => {
    if (!hasUsableAuth || !sessionId || appPage !== "chat" || isRunning || !activeSessionIsProcessing) return;
    if (followingSessionRef.current === sessionId) return;

    const controller = new AbortController();
    followingSessionRef.current = sessionId;
    followingAbortControllerRef.current = controller;
    shouldStickToBottomRef.current = true;
    setStatusText(`Following ${sessionId.slice(0, 8)}`);

    void followProcessingSession(sessionId, controller);

    return () => {
      controller.abort();
      if (followingSessionRef.current === sessionId) followingSessionRef.current = null;
      if (followingAbortControllerRef.current === controller) followingAbortControllerRef.current = null;
    };
  }, [activeSessionIsProcessing, appPage, hasUsableAuth, isRunning, sessionId, settings.serverUrl, settings.token]);

  function showError(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    setStatusText("Error");
  }

  function resetHistoryState(): void {
    oldestLoadedEventSequenceRef.current = null;
    historyLoadingRef.current = false;
    latestEventCursorRef.current = null;
    restoreScrollRef.current = null;
    shouldStickToBottomRef.current = true;
    setHasOlderMessages(false);
    setHistoryLoading(false);
  }

  function focusPromptNow(): boolean {
    const input = promptInputRef.current;
    if (!input) return false;
    input.focus({ preventScroll: true });
    pendingPromptFocusRef.current = false;
    return true;
  }

  function focusPrompt(): void {
    pendingPromptFocusRef.current = true;
    window.requestAnimationFrame(() => {
      if (!focusPromptNow()) {
        window.requestAnimationFrame(() => {
          focusPromptNow();
        });
      }
    });
  }

  function openQuickPrompt(): void {
    setQuickPromptOpen(true);
    setQuickPromptQuery("");
    setQuickPromptSelectedIndex(0);
    window.requestAnimationFrame(() => {
      quickPromptInputRef.current?.focus();
    });
  }

  function closeQuickPrompt(): void {
    setQuickPromptOpen(false);
    setQuickPromptQuery("");
    setQuickPromptSelectedIndex(0);
  }

  function startDraftSession(options: { history?: "push" | "replace" | false } = {}): void {
    abortRun();
    followingAbortControllerRef.current?.abort();
    followingAbortControllerRef.current = null;
    followingSessionRef.current = null;
    setAppPage("chat");
    setMobileSessionsOpen(false);
    closeContainerWorkspace();
    setSessionId("");
    setServerProcessingSessionId(null);
    setMessages([]);
    setPromptHistory(null);
    resetHistoryState();
    setError(null);
    setStatusText("Ready for first prompt");
    if (options.history !== false) updateBrowserRootPath(options.history ?? "push");
  }

  function openSettings(section: SettingsSection | null = null, options: { history?: "push" | "replace" | false } = {}): void {
    setAppPage("settings");
    setMobileSessionsOpen(false);
    closeContainerWorkspace();
    setSettingsSection(section ?? "providers");
    if (options.history !== false) updateBrowserSettingsPath(section, options.history ?? "push");
  }

  function openSettingsSection(section: SettingsSection): void {
    setSettingsSection(section);
    setAppPage("settings");
    updateBrowserSettingsPath(section);
  }

  function openContainerWorkspace(
    next: SelectedContainer,
    options: { history?: "push" | "replace" | false } = {},
  ): void {
    setSessionId(next.sessionId);
    setSelectedContainer(next);
    setContainerPath(".");
    setSelectedFilePath(null);
    setMobileSessionsOpen(false);
    setError(null);
    setStatusText(`Viewing ${next.containerId.slice(0, 12)}`);
    if (options.history !== false) {
      updateBrowserContainerEntryPath(next.containerId, ".", "directory", options.history ?? "push");
    }
  }

  function closeContainerWorkspace(): void {
    setSelectedContainer(null);
    setContainerPath(".");
    setSelectedFilePath(null);
  }

  function resolveContainerSessionId(containerId: string): string | null {
    const matchedSession = sessions.data?.sessions.find((session) => allSessionContainers(session).some((container) => container.id === containerId));
    if (matchedSession) return matchedSession.id;
    return null;
  }

  function openContainerPath(
    container: SelectedContainer,
    path: string,
    fileType: "file" | "directory",
    options: { history?: "push" | "replace" | false } = {},
  ): void {
    const normalizedPath = normalizeQuickFilePath(path);
    if (!normalizedPath && fileType !== "directory") return;
    const nextPath = normalizedPath || ".";

    setAppPage("chat");
    setMobileSessionsOpen(false);
    setSessionId(container.sessionId);
    setSelectedContainer(container);
    setError(null);
    if (fileType === "directory" || nextPath.endsWith("/")) {
      setContainerPath(nextPath);
      setSelectedFilePath(null);
    } else {
      setContainerPath(parentContainerPath(nextPath));
      setSelectedFilePath(nextPath);
    }
    setStatusText(`${fileType === "directory" ? "Opened directory" : "Opened"} ${nextPath}`);
    if (options.history !== false) {
      updateBrowserContainerEntryPath(container.containerId, nextPath, fileType, options.history ?? "push");
    }
  }

  function openContainerEntryRoute(
    target: ContainerRouteEntry,
    options: { history?: "push" | "replace" | false } = {},
  ): void {
    const sessionIdForContainer = resolveContainerSessionId(target.containerId);
    if (!sessionIdForContainer) {
      showError(new Error(`No session found for container ${target.containerId}`));
      return;
    }
    openContainerPath(
      { sessionId: sessionIdForContainer, containerId: target.containerId },
      target.path,
      target.fileType,
      options,
    );
  }

  function openContainerFileLink(link: ContainerFileLink): void {
    const normalizedPath = normalizeQuickFilePath(link.path);
    if (!normalizedPath) return;
    openContainerPath(
      { sessionId, containerId: link.containerId },
      normalizedPath,
      normalizedPath.endsWith("/") ? "directory" : "file",
    );
  }

  async function executeQuickPromptItem(item: QuickPromptItem | undefined): Promise<void> {
    if (!item) return;

    if (item.kind === "command" && !item.argument) {
      const prefix = quickPromptItemCommandPrefix(item);
      if (prefix) {
        setQuickPromptQuery(prefix);
        window.requestAnimationFrame(() => quickPromptInputRef.current?.focus());
      }
      return;
    }

    closeQuickPrompt();

    switch (item.kind) {
      case "file":
        openContainerPath(
          { sessionId: item.sessionId, containerId: item.containerId },
          item.path,
          item.fileType,
        );
        return;
      case "container":
        openContainerWorkspace({ sessionId: item.sessionId, containerId: item.containerId });
        return;
      case "session":
        await openSession(item.sessionId);
        focusPrompt();
        return;
      case "prompt":
        setAppPage("chat");
        setMobileSessionsOpen(false);
        closeContainerWorkspace();
        focusPrompt();
        void submitPromptContent(item.prompt);
        return;
      case "command":
        if (item.command === "rename-session") {
          setAppPage("chat");
          setMobileSessionsOpen(false);
          closeContainerWorkspace();
          renameSession.mutate(item.argument);
        } else if (item.command === "rename-container" && item.containerId) {
          renameContainer.mutate({ containerId: item.containerId, name: item.argument });
        }
        return;
    }
  }

  function rememberSessionContainers(targetSessionId: string, displayMessages: DisplayMessage[]): void {
    const containers = inferContainerIds(targetSessionId, displayMessages);
    if (containers.length === 0) return;

    queryClient.setQueryData<SessionListResponse>(["sessions", settings.serverUrl, settings.token], (current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== targetSessionId) return session;
          if (session.containerDetails?.length) return session;
          return {
            ...session,
            containers: mergeContainers(session.containers ?? [], containers),
          };
        }),
      };
    });
  }

  async function loginWithGithub(): Promise<void> {
    const parsed = z.object({ serverUrl: z.string().url("Enter a valid server URL") }).safeParse({
      serverUrl: settings.serverUrl,
    });
    if (!parsed.success) {
      setSettingsError(parsed.error.issues[0]?.message ?? "Invalid server URL");
      return;
    }

    setSettingsError(null);
    setError(null);
    setLoginStatus("starting");
    setLoginMessage("Starting GitHub OAuth");
    setLoginUser(null);

    const authClient = new ClawflareApiClient(parsed.data.serverUrl, "");

    try {
      const device = await authClient.startDeviceAuth("github", window.location.href);
      const authUrl = device.authorizationUrl ?? device.verificationUrl;
      loginWindowRef.current = window.open(authUrl, "clawflare-github-login", "popup,width=720,height=820");
      if (!loginWindowRef.current) {
        window.location.assign(authUrl);
        return;
      }

      setLoginStatus("waiting");
      setLoginMessage(`Waiting for GitHub approval. Device code: ${device.userCode}`);

      const deadline = Date.now() + Math.min(device.expiresIn, 600) * 1000;
      const pollMs = Math.max(1, device.interval) * 1000;

      while (Date.now() < deadline) {
        const result = await authClient.pollDeviceAuth(device.deviceCode);

        if (result.status === "complete") {
          if (!result.accessToken) {
            throw new Error("GitHub approved the login, but the server did not return an access token. Please try again.");
          }

          const nextSettings = {
            serverUrl: parsed.data.serverUrl,
            token: result.accessToken,
          };
          saveSettings(nextSettings);
          setSettings(nextSettings);
          setSessionId("");
          setServerProcessingSessionId(null);
          setMessages([]);
          setPromptHistory(null);
          resetHistoryState();
          setLoginStatus("approved");
          setLoginUser(result.user?.displayName ?? result.user?.email ?? null);
          setLoginMessage("Approved!");
          setStatusText("Approved");
          loginWindowRef.current?.close();
          window.focus();
          void queryClient.clear();
          return;
        }

        if (result.status === "denied") {
          throw new Error(result.message ?? "GitHub login was denied.");
        }
        if (result.status === "expired") {
          throw new Error(result.message ?? "GitHub login expired. Please try again.");
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      throw new Error("GitHub login timed out. Please try again.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLoginStatus("error");
      setLoginMessage(message);
      showError(cause);
    }
  }

  async function openSession(
    targetSessionId: string,
    options: { history?: "push" | "replace" | false } = {},
  ): Promise<void> {
    try {
      setStatusText("Opening session");
      const session = await client.getSession(targetSessionId, undefined, false, {
        eventWindow: "tail",
        eventLimit: 100,
        includePromptHistory: true,
      });
      const recentMessages = formatMessagesFromEvents(session.events);
      const oldestSequence = oldestEventSequence(session.events);
      setAppPage("chat");
      setMobileSessionsOpen(false);
      setSelectedContainer(null);
      setSelectedFilePath(null);
      setSessionId(session.id);
      setServerProcessingSessionId(session.status === "processing" ? session.id : null);
      if (options.history !== false) updateBrowserSessionPath(session.id, options.history ?? "push");
      shouldStickToBottomRef.current = true;
      setMessages(attachToolResults(recentMessages));
      rememberSessionContainers(session.id, recentMessages);
      setPromptHistory(session.promptHistory ?? null);
      oldestLoadedEventSequenceRef.current = oldestSequence;
      latestEventCursorRef.current = session.nextEventCursor;
      historyLoadingRef.current = false;
      setHasOlderMessages(Boolean(oldestSequence && oldestSequence > 1));
      setHistoryLoading(false);
      setError(session.status === "error" ? session.errorMessage ?? null : null);
      setStatusText(`Opened recent ${session.id.slice(0, 8)}`);
      focusPrompt();
    } catch (cause) {
      showError(cause);
    }
  }

  async function loadPreviousMessages(): Promise<void> {
    const before = oldestLoadedEventSequenceRef.current;
    if (!sessionId || !before || before <= 1 || historyLoadingRef.current || !hasOlderMessages) return;

    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setStatusText("Loading earlier messages");

    try {
      const session = await client.getSession(sessionId, undefined, false, {
        eventWindow: "before",
        before: String(before),
        eventLimit: 100,
        includePromptHistory: true,
      });
      const olderMessages = attachToolResults(formatMessagesFromEvents(session.events));
      const nextOldestSequence = oldestEventSequence(session.events);

      if (session.events.length === 0 || !nextOldestSequence) {
        restoreScrollRef.current = null;
        setHasOlderMessages(false);
        setStatusText("No earlier messages");
        return;
      }

      const scroller = messageScrollerRef.current;
      if (scroller) {
        restoreScrollRef.current = {
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
        };
      }
      oldestLoadedEventSequenceRef.current = nextOldestSequence;
      setHasOlderMessages(nextOldestSequence > 1);
      setPromptHistory(session.promptHistory ?? promptHistory);
      setMessages((current) => [...olderMessages, ...current]);
      rememberSessionContainers(session.id, [...olderMessages, ...messages]);
      setStatusText(`Loaded earlier ${session.id.slice(0, 8)}`);
    } catch (cause) {
      showError(cause);
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }

  async function followProcessingSession(targetSessionId: string, controller: AbortController): Promise<void> {
    try {
      const initialSession = latestEventCursorRef.current
        ? null
        : await client.getSession(targetSessionId, undefined, false, {
            eventWindow: "tail",
            eventLimit: 100,
            includePromptHistory: true,
          });

      if (controller.signal.aborted || sessionId !== targetSessionId) return;

      if (initialSession) {
        const recentMessages = attachToolResults(formatMessagesFromEvents(initialSession.events));
        const oldestSequence = oldestEventSequence(initialSession.events);
        setMessages(recentMessages);
        rememberSessionContainers(targetSessionId, recentMessages);
        setPromptHistory(initialSession.promptHistory ?? null);
        oldestLoadedEventSequenceRef.current = oldestSequence;
        latestEventCursorRef.current = initialSession.nextEventCursor;
        setHasOlderMessages(Boolean(oldestSequence && oldestSequence > 1));
        setServerProcessingSessionId(initialSession.status === "processing" ? targetSessionId : null);
        if (initialSession.status !== "processing") {
          setStatusText(initialSession.status === "error" ? "Error" : "Complete");
          if (initialSession.status === "error") setError(initialSession.errorMessage ?? "Session failed");
          await queryClient.invalidateQueries({ queryKey: ["sessions"] });
          return;
        }
      }

      for await (const update of client.streamSession(targetSessionId, latestEventCursorRef.current ?? undefined, controller.signal)) {
        if (controller.signal.aborted || sessionId !== targetSessionId) return;
        latestEventCursorRef.current = update.session.nextEventCursor;
        const lastEvent = [...update.newEvents].reverse().map(getEventDisplayMessage).find(Boolean);
        if (lastEvent) setStatusText(lastEvent);

        setMessages((current) => {
          const serverMessages = attachToolResults((update.session.messages ?? []).map(formatMessageForDisplay));
          const base = serverMessages.length ? serverMessages : current;
          const next = attachToolResults(applyAssistantPartialEvents(base, update.newEvents));
          rememberSessionContainers(targetSessionId, next);
          return next;
        });
        setPromptHistory(update.session.promptHistory ?? null);

        if (update.complete) {
          if (update.session.status === "error") {
            throw new Error(update.session.errorMessage ?? "Session failed");
          }
          break;
        }
      }

      if (controller.signal.aborted || sessionId !== targetSessionId) return;
      const finalSession = await client.getSession(targetSessionId, undefined, true, {
        eventWindow: "tail",
        eventLimit: 100,
        includePromptHistory: true,
      });
      latestEventCursorRef.current = finalSession.nextEventCursor;
      setMessages(attachToolResults((finalSession.messages ?? []).map(formatMessageForDisplay)));
      rememberSessionContainers(targetSessionId, attachToolResults((finalSession.messages ?? []).map(formatMessageForDisplay)));
      setPromptHistory(finalSession.promptHistory ?? null);
      setServerProcessingSessionId(null);
      if (stoppingSessionId === targetSessionId) {
        setStoppingSessionId(null);
        if (abortingSessionIdRef.current === targetSessionId) abortingSessionIdRef.current = null;
      }
      setStatusText(finalSession.status === "error" ? "Error" : "Complete");
      setError(finalSession.status === "error" ? finalSession.errorMessage ?? "Session failed" : null);
      await queryClient.invalidateQueries({ queryKey: ["container-find-paths"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      if (controller.signal.aborted || sessionId !== targetSessionId) return;
      showError(cause);
    } finally {
      if (followingSessionRef.current === targetSessionId) followingSessionRef.current = null;
      if (followingAbortControllerRef.current === controller) followingAbortControllerRef.current = null;
    }
  }

  function handleCommand(commandText: string): boolean {
    if (!commandText.startsWith("/")) return false;
    const [command = "", ...parts] = commandText.slice(1).split(" ");
    const args = parts.join(" ").trim();

    switch (command) {
      case "new":
        startDraftSession();
        return true;
      case "fork":
        startDraftSession();
        return true;
      case "sessions":
        setStatusText("Sessions refreshed");
        void sessions.refetch();
        return true;
      case "open":
        void resolveAndOpenSession(args);
        return true;
      case "kill":
        void handleKill(args);
        return true;
      case "delete":
      case "rm":
        void handleDelete(args);
        return true;
      case "name":
      case "rename":
        if (args) renameSession.mutate(args);
        else showError(new Error(`Usage: /${command} <session-name>`));
        return true;
      case "models":
        openSettingsSection("models");
        return true;
      case "cf_debug":
        showError(new Error("cf_debug is not available in the web settings page."));
        return true;
      case "clear":
        setMessages([]);
        setPromptHistory(null);
        setStatusText("Chat cleared");
        return true;
      case "help":
        setMessages((current) => [...current, { role: "assistant", content: helpText }]);
        return true;
      case "exit":
        setStatusText("The web app stays open in this tab");
        return true;
      default:
        showError(new Error(`Unknown command: /${command}`));
        return true;
    }
  }

  async function resolveAndOpenSession(input: string): Promise<void> {
    if (!input) {
      setStatusText("Choose a session from the sidebar");
      return;
    }
    if (input.length >= 32) {
      await openSession(input);
      return;
    }
    const response = await client.listSessions({ status: "all", limit: 100 });
    const matches = response.sessions.filter((session) => session.id.startsWith(input));
    if (matches.length === 1) await openSession(matches[0]!.id);
    else if (matches.length > 1) showError(new Error(`Session id prefix "${input}" is ambiguous`));
    else showError(new Error(`No recent session matches "${input}"`));
  }

  async function handleKill(input: string): Promise<void> {
    if (input === "all") {
      const response = await client.listSessions({ status: "all", limit: 100 });
      const targets = response.sessions.filter((session) => session.status !== "closed" && session.status !== "expired");
      for (const target of targets) {
        await client.killSession(target.id);
      }
      setMessages((current) => [...current, { role: "assistant", content: `Killed ${targets.length} sessions.` }]);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      return;
    }
    const target = input || sessionId;
    if (!target) throw new Error("Usage: /kill [session-id|all]");
    killSession.mutate(target);
  }

  async function handleDelete(input: string): Promise<void> {
    try {
      if (input === "all") {
        const result = await client.deleteSessions();
        setSessionId("");
        resetHistoryState();
        updateBrowserRootPath("replace");
        setMessages((current) => [...current, {
          role: result.ok ? "assistant" : "error",
          content: formatDeleteAllResult(result),
        }]);
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        return;
      }
      const target = input || sessionId;
      if (!target) throw new Error("Usage: /delete [session-id|all]");
      deleteSession.mutate(target);
    } catch (cause) {
      showError(cause);
    }
  }

  async function submitPrompt(): Promise<void> {
    await submitPromptContent(prompt);
  }

  async function submitPromptContent(promptContent: string): Promise<void> {
    const content = promptContent.trim();
    if (!content) return;

    if (handleCommand(content)) {
      setPrompt("");
      setComposerRows(2);
      return;
    }

    if (composerBusy) {
      showError(new Error("Agent is still running. Wait for this turn to finish or abort it first."));
      return;
    }

    const optimistic: DisplayMessage = { role: "user", content };
    const currentSessionId = sessionId;

    shouldStickToBottomRef.current = true;
    setPrompt("");
    setComposerRows(2);
    setIsRunning(true);
    setError(null);
    setStatusText("Submitting");
    const controller = new AbortController();
    abortController.current = controller;
    runningSessionIdRef.current = currentSessionId || null;

    try {
      const submitted = await client.submitChat({
        content,
        sessionId: currentSessionId || undefined,
      });
      setSessionId(submitted.sessionId);
      const submittedName = submitted.name;
      if (submittedName) {
        queryClient.setQueryData<SessionListResponse>(["sessions", settings.serverUrl, settings.token], (current) => {
          if (!current) return current;
          return {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === submitted.sessionId ? { ...session, name: submittedName } : session
            ),
          };
        });
      }
      runningSessionIdRef.current = submitted.sessionId;
      updateBrowserSessionPath(submitted.sessionId, currentSessionId ? "replace" : "push");
      setStatusText(`Processing ${submitted.sessionId.slice(0, 8)}`);
      setMessages((current) => [...current, optimistic]);

      for await (const update of client.streamSession(submitted.sessionId, submitted.eventCursor, controller.signal)) {
        latestEventCursorRef.current = update.session.nextEventCursor;
        const lastEvent = [...update.newEvents].reverse().map(getEventDisplayMessage).find(Boolean);
        if (lastEvent) setStatusText(lastEvent);

        setMessages((current) => {
          const serverMessages = attachToolResults((update.session.messages ?? []).map(formatMessageForDisplay));
          const base = mergeCurrentTurnMessages(current, serverMessages, content, optimistic);
          const next = attachToolResults(applyAssistantPartialEvents(base, update.newEvents));
          rememberSessionContainers(submitted.sessionId, next);
          return next;
        });
        setPromptHistory(update.session.promptHistory ?? null);

        if (update.complete) {
          if (update.session.status === "error") {
            throw new Error(update.session.errorMessage ?? "Session failed");
          }
          break;
        }
      }

      const finalSession = await client.getSession(submitted.sessionId, undefined, true, {
        eventWindow: "tail",
        eventLimit: 100,
        includePromptHistory: true,
      });
      latestEventCursorRef.current = finalSession.nextEventCursor;
      setMessages((current) => {
        const serverMessages = attachToolResults((finalSession.messages ?? []).map(formatMessageForDisplay));
        const next = mergeCurrentTurnMessages(current, serverMessages, content, optimistic);
        rememberSessionContainers(submitted.sessionId, next);
        return next;
      });
      setPromptHistory(finalSession.promptHistory ?? null);
      setStatusText("Complete");
      setServerProcessingSessionId(null);
      if (stoppingSessionId === submitted.sessionId) {
        setStoppingSessionId(null);
        if (abortingSessionIdRef.current === submitted.sessionId) abortingSessionIdRef.current = null;
      }
      await queryClient.invalidateQueries({ queryKey: ["container-find-paths"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      if (controller.signal.aborted) {
        const abortedSessionId = abortingSessionIdRef.current;
        if (abortedSessionId) {
          setStoppingSessionId(abortedSessionId);
          setServerProcessingSessionId(abortedSessionId);
          setStatusText("Stopping agent");
        } else {
          setStatusText("Aborted");
        }
      } else {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (isAlreadyProcessingError(message) && currentSessionId) {
          setServerProcessingSessionId(currentSessionId);
          setStatusText("Agent is running");
          void sessions.refetch();
        } else {
          setStatusText("Error");
        }
        setPrompt((current) => current || content);
      }
    } finally {
      setIsRunning(false);
      abortController.current = null;
      runningSessionIdRef.current = null;
    }
  }

  function abortRun(): void {
    const targetSessionId = runningSessionIdRef.current || sessionId || serverProcessingSessionId;
    if (targetSessionId) {
      abortingSessionIdRef.current = targetSessionId;
      setStoppingSessionId(targetSessionId);
      setServerProcessingSessionId(targetSessionId);
      setStatusText("Stopping agent");
      void client.abortSession(targetSessionId)
        .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
        .catch(showError);
    }
    abortController.current?.abort();
    abortController.current = null;
    followingAbortControllerRef.current?.abort();
    followingAbortControllerRef.current = null;
    if (followingSessionRef.current === targetSessionId) followingSessionRef.current = null;
    setIsRunning(false);
    setServerProcessingSessionId(null);
  }

  function signOut(): void {
    const nextSettings = { ...settings, token: "" };
    saveSettings(nextSettings);
    setSettings(nextSettings);
    setSessionId("");
    setServerProcessingSessionId(null);
    setMessages([]);
    setPromptHistory(null);
    resetHistoryState();
    setError(null);
    setLoginStatus("idle");
    setLoginMessage("");
    setLoginUser(null);
    setStatusText("Signed out");
    updateBrowserRootPath("replace");
    void queryClient.clear();
  }

  function confirmDeleteAllSessions(total: number): void {
    if (total === 0) return;
    if (window.confirm(`Delete all ${total} sessions? Active sessions will be killed first to release resources.`)) {
      void handleDelete("all");
    }
  }

  const selectedProviderInfo = providers.data?.find((provider) => provider.id === selectedProvider);
  const selectedEgressInfo = availableEgress.data?.find((handler) => handler.egressHandlerId === selectedEgress);
  const connected = hasUsableAuth && !currentUser.isError;

  if (!isConfigured || hasInvalidAuth) {
    return (
      <LoginScreen
        settingsError={settingsError}
        loginStatus={loginStatus === "idle" && hasInvalidAuth ? "error" : loginStatus}
        loginMessage={loginMessage || (hasInvalidAuth ? "Your session expired or token is invalid. Log in with GitHub to continue." : "")}
        loginUser={loginUser}
        onLogin={() => void loginWithGithub()}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-0 bg-shell-950 text-slate-100">
      {quickPromptOpen ? (
        <QuickPromptPalette
          inputRef={quickPromptInputRef}
          query={quickPromptQuery}
          items={quickPromptItems}
          selectedIndex={quickPromptSelectedIndex}
          loadingFiles={quickFiles.isFetching && quickPromptContainers.length > 0}
          onQueryChange={setQuickPromptQuery}
          onSelectedIndexChange={setQuickPromptSelectedIndex}
          onClose={closeQuickPrompt}
          onSelect={executeQuickPromptItem}
        />
      ) : null}
      <aside className={`hidden shrink-0 border-r border-shell-700 bg-shell-900/95 transition-[width] md:flex md:flex-col ${sessionsCollapsed ? "w-14" : "w-72"}`}>
        <SessionSidebar
          currentSessionId={sessionId}
          sessions={sessions.data?.sessions ?? []}
          now={containerClock}
          collapsed={sessionsCollapsed}
          selectedContainer={selectedContainer}
          onNew={startDraftSession}
          onOpen={(id) => void openSession(id)}
          onOpenContainer={openContainerWorkspace}
          onToggleCollapsed={() => setSessionsCollapsed((current) => !current)}
          onRefresh={() => {
            setStatusText("Sessions refreshed");
            void sessions.refetch();
          }}
          refreshing={sessions.isFetching}
          onSettings={() => openSettings()}
          settingsActive={appPage === "settings"}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-shell-700 bg-shell-900/90 px-3 py-3 sm:px-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Bot className="h-4 w-4 text-accent-500" />
              <span className="truncate">Clawflare Web</span>
              {sessionId ? <span className="rounded bg-shell-800 px-2 py-0.5 font-mono text-xs">{sessionId.slice(0, 8)}</span> : null}
            </div>
            <h1 className="truncate text-base font-semibold text-slate-100">
              {currentSession?.name || (sessionId ? "Agent chat" : "Connect to start")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={statusText} connected={connected} />
            <div className="flex items-center gap-2 md:hidden">
              <IconButton title="New chat" onClick={() => startDraftSession()}>
                <Plus className="h-4 w-4" />
              </IconButton>
              <IconButton title="Sessions" active={mobileSessionsOpen} onClick={() => setMobileSessionsOpen((current) => !current)}>
                <MessageSquare className="h-4 w-4" />
              </IconButton>
            </div>
          </div>
        </header>

        {mobileSessionsOpen ? (
          <section className="flex max-h-[min(75dvh,38rem)] shrink-0 flex-col border-b border-shell-700 bg-shell-900/98 shadow-panel md:hidden">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-shell-700 px-3">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <MessageSquare className="h-4 w-4 text-accent-500" />
                Sessions
              </div>
              <IconButton title="Close sessions" onClick={() => setMobileSessionsOpen(false)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <SessionSidebar
              currentSessionId={sessionId}
              sessions={sessions.data?.sessions ?? []}
              now={containerClock}
              collapsed={false}
              selectedContainer={selectedContainer}
              onNew={startDraftSession}
              onOpen={(id) => void openSession(id)}
              onOpenContainer={openContainerWorkspace}
              onToggleCollapsed={() => setMobileSessionsOpen(false)}
              onRefresh={() => {
                setStatusText("Sessions refreshed");
                void sessions.refetch();
              }}
              refreshing={sessions.isFetching}
              onSettings={() => openSettings()}
              settingsActive={appPage === "settings"}
            />
          </section>
        ) : null}

        {appPage === "settings" ? (
          <SettingsPage
            section={settingsSection}
            settingsError={settingsError}
            loginStatus={loginStatus}
            loginMessage={loginMessage}
            loginUser={loginUser}
            providers={providers.data ?? []}
            workspaceProviders={workspaceProviders.data ?? []}
            providerModels={providerModels.data ?? []}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            showModelForm={showModelForm}
            selectedProviderInfo={selectedProviderInfo}
            models={models.data?.models ?? []}
            defaultModelId={models.data?.defaultModelId}
            modelSecrets={modelSecrets}
            availableEgress={availableEgress.data ?? []}
            configuredEgress={configuredEgress.data ?? []}
            selectedEgress={selectedEgress}
            showEgressForm={showEgressForm}
            selectedEgressInfo={selectedEgressInfo}
            egressSecrets={egressSecrets}
            egressConfig={egressConfig}
            egressEnabled={egressEnabled}
            sessionsTotal={sessions.data?.total ?? 0}
            isConfigured={isConfigured}
            onSectionChange={openSettingsSection}
            onLogin={() => void loginWithGithub()}
            onSignOut={signOut}
            onProviderChange={setSelectedProvider}
            onModelChange={setSelectedModel}
            onToggleModelForm={() => setShowModelForm((current) => !current)}
            onModelSecretChange={(key, value) => setModelSecrets((current) => ({ ...current, [key]: value }))}
            onCreateModel={() => addProvider.mutate()}
            onDeleteProvider={(id) => deleteProvider.mutate(id)}
            onDeleteModel={(id) => deleteModel.mutate(id)}
            onSetDefaultModel={(id) => setDefaultModel.mutate(id)}
            onEgressChange={setSelectedEgress}
            onToggleEgressForm={() => setShowEgressForm((current) => !current)}
            onEgressSecretChange={(key, value) => setEgressSecrets((current) => ({ ...current, [key]: value }))}
            onEgressConfigChange={(key, value) => setEgressConfig((current) => ({ ...current, [key]: value }))}
            onEgressEnabledChange={setEgressEnabled}
            onConfigureEgress={() => configureEgress.mutate()}
            onToggleEgress={(id, enabled) => updateEgress.mutate({ id, enabled })}
            onDeleteEgress={(id) => deleteEgress.mutate(id)}
            onDeleteAll={() => confirmDeleteAllSessions(sessions.data?.total ?? 0)}
          />
        ) : (
          <>
            {selectedContainer ? (
              <ContainerWorkspaceView
                selectedContainer={selectedContainer}
                selectedContainerSummary={selectedContainerSummary}
                path={containerPath}
                listing={containerListing.data}
                listingLoading={containerListing.isFetching}
                filePath={selectedFilePath}
                file={selectedFile.data}
                fileLoading={selectedFile.isFetching}
                error={error}
                onDismissError={() => setError(null)}
                onClose={() => {
                  closeContainerWorkspace();
                  if (sessionId) updateBrowserSessionPath(sessionId);
                  else updateBrowserRootPath();
                }}
                onOpenDirectory={(path) => {
                  if (selectedContainer) openContainerPath(selectedContainer, path, "directory");
                }}
                onOpenFile={(path) => {
                  if (selectedContainer) openContainerPath(selectedContainer, path, "file");
                }}
                onRefresh={() => void containerListing.refetch()}
              />
            ) : (
              <section
                ref={messageScrollerRef}
                className="scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-4 sm:py-6"
                onScroll={(event) => {
                  const scroller = event.currentTarget;
                  shouldStickToBottomRef.current = isNearBottom(scroller);
                  if (scroller.scrollTop < 96) void loadPreviousMessages();
                }}
              >
                <div className="mx-auto flex max-w-4xl flex-col gap-5">
                  {sessionId && (historyLoading || hasOlderMessages) ? (
                    <div className="flex justify-center">
                      <button
                        className="flex h-8 items-center gap-2 rounded-md border border-shell-700 bg-shell-850 px-3 text-xs text-slate-400 transition hover:border-shell-600 hover:text-slate-200 disabled:cursor-wait disabled:opacity-70"
                        disabled={historyLoading}
                        onClick={() => void loadPreviousMessages()}
                      >
                        {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5 rotate-180" />}
                        {historyLoading ? "Loading earlier" : "Load earlier"}
                      </button>
                    </div>
                  ) : null}
                  {!isConfigured ? (
                    <EmptyState
                      icon={<KeyRound className="h-7 w-7" />}
                      title="Add your Clawflare endpoint and token"
                      body="The web client stores them locally in this browser and sends requests directly to the Clawflare API."
                    />
                  ) : checkingProviderSetup ? (
                    <EmptyState
                      icon={<Loader2 className="h-7 w-7 animate-spin" />}
                      title="Checking workspace setup"
                      body="Looking for a configured provider before starting a new agent turn."
                    />
                  ) : needsProviderSetup ? (
                    <EmptyState
                      icon={<KeyRound className="h-7 w-7" />}
                      title="Configure a provider to start"
                      body="Add a provider and choose a model before starting a new agent turn."
                      action={(
                        <button className="primary-btn mx-auto mt-5" onClick={() => openSettings("providers")}>
                          <KeyRound className="h-4 w-4" />
                          Configure providers
                        </button>
                      )}
                    />
                  ) : messages.length === 0 ? (
                    <EmptyState
                      icon={<MessageSquare className="h-7 w-7" />}
                      title="Ready for a new turn"
                      body="Ask the agent to inspect sessions, write code, use containers, or configure integrations."
                    />
                  ) : (
                    <>
                      <PromptHistoryReveal promptHistory={promptHistory} visibleMessages={messages} />
                      {messages.map((message, index) => (
                        <ChatMessage
                          key={`${index}-${message.role}`}
                          message={message}
                          containerIds={currentContainerIds}
                          onOpenContainerFile={openContainerFileLink}
                        />
                      ))}
                    </>
                  )}
                  {composerBusy && !activeSessionIsStopping ? <Thinking /> : null}
                  {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
                  <div ref={messageEndRef} />
                </div>
              </section>
            )}

            {!selectedContainer ? (
            <footer className="border-t border-shell-700 bg-shell-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="mx-auto max-w-4xl">
                <div className="flex items-end gap-2 rounded-lg border border-shell-600 bg-shell-850 p-2 shadow-panel">
                  <textarea
                    ref={promptInputRef}
                    className="scrollbar min-h-11 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
                    rows={composerRows}
                    value={prompt}
                    placeholder={checkingProviderSetup ? "Checking workspace setup..." : needsProviderSetup ? "Configure a provider before chatting" : activeSessionIsStopping ? "Stopping agent..." : composerBusy ? "Agent is running..." : "Message Clawflare or type /help"}
                    disabled={!hasUsableAuth || checkingProviderSetup || needsProviderSetup}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      setComposerRows(Math.min(8, Math.max(2, event.target.value.split("\n").length)));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        blurTextEntryElement(event.currentTarget);
                        return;
                      }
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submitPrompt();
                      }
                    }}
                  />
                  {composerBusy ? (
                    <IconButton title="Abort" onClick={abortRun}>
                      {activeSessionIsStopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                    </IconButton>
                  ) : (
                    <button
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white transition hover:bg-accent-500 disabled:bg-shell-700"
                      disabled={!prompt.trim() || !hasUsableAuth || checkingProviderSetup || needsProviderSetup || composerBusy}
                      title="Send"
                      onClick={() => void submitPrompt()}
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </footer>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

interface SessionSidebarProps {
  currentSessionId: string;
  sessions: SessionSummary[];
  now: number;
  collapsed: boolean;
  selectedContainer: SelectedContainer | null;
  onNew: () => void;
  onOpen: (sessionId: string) => void;
  onOpenContainer: (container: SelectedContainer) => void;
  onToggleCollapsed: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onSettings: () => void;
  settingsActive: boolean;
}

function SessionSidebar(props: SessionSidebarProps): JSX.Element {
  return (
    <>
      <div className={`flex h-16 items-center border-b border-shell-700 ${props.collapsed ? "justify-center px-1" : "justify-between px-3"}`}>
        <button
          className={`flex h-10 items-center justify-center gap-2 rounded-md bg-slate-100 text-sm font-medium text-shell-950 transition hover:bg-white ${props.collapsed ? "w-10 px-0" : "px-3"}`}
          title="New chat"
          onClick={props.onNew}
        >
          <Plus className="h-4 w-4" />
          {props.collapsed ? null : "New chat"}
        </button>
        {props.collapsed ? null : (
          <div className="flex items-center gap-1">
            <IconButton title="Refresh sessions" onClick={props.onRefresh}>
              <RefreshCw className={`h-4 w-4 ${props.refreshing ? "animate-spin" : ""}`} />
            </IconButton>
            <IconButton title="Minimize sessions" onClick={props.onToggleCollapsed}>
              <PanelLeftClose className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
      {props.collapsed ? (
        <div className="border-b border-shell-700 p-1">
          <IconButton title="Expand sessions" onClick={props.onToggleCollapsed}>
            <PanelLeftOpen className="h-4 w-4" />
          </IconButton>
        </div>
      ) : null}
      <div className={`scrollbar min-h-0 flex-1 overflow-y-auto ${props.collapsed ? "p-1" : "p-2"}`}>
        {props.sessions.map((session) => {
          const sessionContainers = allSessionContainers(session);
          return (
            <div
              key={session.id}
              className="mb-2"
            >
              <button
                className={`flex w-full min-w-0 items-center gap-2 rounded-md text-left transition hover:bg-shell-800 ${
                  props.collapsed ? "h-10 justify-center px-0" : "px-2 py-2"
                } ${
                  session.id === props.currentSessionId ? "bg-shell-800 text-slate-100" : "text-slate-300"
                }`}
                title={formatSessionTitle(session)}
                onClick={() => props.onOpen(session.id)}
              >
                {props.collapsed ? (
                  <MessageSquare className="h-4 w-4 text-slate-300" />
                ) : (
                  <>
                    <MessageSquare className="h-4 w-4 shrink-0 text-slate-500" />
                    <span className={`truncate text-[0.95rem] ${session.id === props.currentSessionId ? "font-semibold" : "font-medium"}`}>
                      {formatSessionTitle(session)}
                    </span>
                  </>
                )}
              </button>
              {props.collapsed ? (
                <div className="mb-1 flex flex-col items-center gap-1">
                  {sessionContainers.map((container) => (
                    <ContainerIconButton
                      key={container.id}
                      container={container}
                      sessionId={session.id}
                      selected={props.selectedContainer?.sessionId === session.id && props.selectedContainer.containerId === container.id}
                      now={props.now}
                      onOpen={props.onOpenContainer}
                    />
                  ))}
                </div>
              ) : (
                <div className="mb-1 flex flex-col gap-0.5">
                  {sessionContainers.map((container) => (
                    <ContainerRowButton
                      key={container.id}
                      container={container}
                      sessionId={session.id}
                      selected={props.selectedContainer?.sessionId === session.id && props.selectedContainer.containerId === container.id}
                      now={props.now}
                      onOpen={props.onOpenContainer}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {props.sessions.length === 0 && !props.collapsed ? <p className="px-2 py-6 text-sm text-slate-500">No sessions found.</p> : null}
      </div>
      <div className={`border-t border-shell-700 ${props.collapsed ? "p-1" : "p-3"}`}>
        <button
          className={`flex h-9 w-full items-center justify-center gap-2 rounded-md border text-sm transition ${props.collapsed ? "px-0" : "px-3"} ${
            props.settingsActive
              ? "border-accent-600 bg-accent-600/20 text-accent-300"
              : "border-shell-700 bg-shell-850 text-slate-300 hover:bg-shell-800"
          }`}
          title="Settings"
          onClick={props.onSettings}
        >
          <Settings className="h-4 w-4" />
          {props.collapsed ? null : "Settings"}
        </button>
      </div>
    </>
  );
}

function ContainerIconButton(props: {
  container: ContainerSummary;
  sessionId: string;
  selected: boolean;
  now: number;
  onOpen: (container: SelectedContainer) => void;
}): JSX.Element {
  const disabled = props.container.status === "destroyed";
  const sleeping = isContainerSleeping(props.container, props.now);
  const label = containerDisplayName(props.container);

  return (
    <button
      className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-shell-800 ${
        props.selected ? "bg-accent-600/15 text-accent-300" : disabled || sleeping ? "text-slate-700" : "text-slate-500"
      }`}
      title={containerTitle(props.container, props.now)}
      disabled={disabled}
      onClick={() => props.onOpen({ sessionId: props.sessionId, containerId: props.container.id })}
    >
      {disabled ? <Trash2 className="h-4 w-4" /> : <Terminal className="h-4 w-4" aria-label={label} />}
    </button>
  );
}

function ContainerRowButton(props: {
  container: ContainerSummary;
  sessionId: string;
  selected: boolean;
  now: number;
  onOpen: (container: SelectedContainer) => void;
}): JSX.Element {
  const disabled = props.container.status === "destroyed";
  const sleeping = isContainerSleeping(props.container, props.now);
  const status = containerStatusInfo(props.container, props.now);

  return (
    <button
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-shell-850 ${
        props.selected ? "bg-accent-600/15 text-accent-200" : disabled || sleeping ? "text-slate-600" : "text-slate-400"
      }`}
      title={containerTitle(props.container, props.now)}
      disabled={disabled}
      onClick={() => props.onOpen({ sessionId: props.sessionId, containerId: props.container.id })}
    >
      {disabled ? <Trash2 className="h-4 w-4 shrink-0" /> : <Terminal className="h-4 w-4 shrink-0" />}
      <span className="truncate">{containerDisplayName(props.container)}</span>
      <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[0.68rem] font-medium leading-none ${
        status.tone === "awake"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : status.tone === "sleeping"
            ? "border-slate-700 bg-shell-950 text-slate-500"
            : status.tone === "removed"
              ? "border-slate-700 bg-shell-950 text-slate-600"
              : "border-shell-700 bg-shell-950 text-slate-500"
      }`}>
        {status.label}
      </span>
    </button>
  );
}

function ContainerWorkspaceView(props: {
  selectedContainer: SelectedContainer;
  selectedContainerSummary?: ContainerSummary;
  path: string;
  listing?: ContainerLsDetails;
  listingLoading: boolean;
  filePath: string | null;
  file?: ContainerFile;
  fileLoading: boolean;
  error: string | null;
  onDismissError: () => void;
  onClose: () => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <section className="scrollbar min-h-0 flex-1 overflow-auto bg-shell-950">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-5 sm:px-4 sm:py-6">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-shell-700 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Terminal className="h-3.5 w-3.5 text-accent-500" />
              <span className="truncate" title={props.selectedContainer.containerId}>
                {props.selectedContainerSummary ? containerDisplayName(props.selectedContainerSummary) : props.selectedContainer.containerId.slice(0, 12)}
              </span>
            </div>
            <h2 className="truncate font-mono text-sm font-semibold text-slate-100">/workspace/{props.path === "." ? "" : props.path}</h2>
          </div>
          <div className="flex items-center gap-2">
            <IconButton title="Close container view" onClick={props.onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        {props.error ? <ErrorBanner message={props.error} onDismiss={props.onDismissError} /> : null}
        {props.filePath ? (
          <InlineFileViewer file={props.file} path={props.filePath} loading={props.fileLoading} onOpenDirectory={props.onOpenDirectory} />
        ) : (
          <>
            <ContainerDirectoryBrowser
              path={props.path}
              listing={props.listing}
              loading={props.listingLoading}
              onOpenDirectory={props.onOpenDirectory}
              onOpenFile={props.onOpenFile}
              onRefresh={props.onRefresh}
            />
          </>
        )}
      </div>
    </section>
  );
}

function ContainerDirectoryBrowser(props: {
  path: string;
  listing?: ContainerLsDetails;
  loading: boolean;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const entries = props.listing?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((entry) => entry.type === "file").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="rounded-md border border-shell-700 bg-shell-900">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-shell-700 px-3 py-2">
        <Breadcrumbs path={props.path} onOpenDirectory={props.onOpenDirectory} />
        <IconButton title="Refresh directory" onClick={props.onRefresh}>
          <RefreshCw className={`h-4 w-4 ${props.loading ? "animate-spin" : ""}`} />
        </IconButton>
      </div>
      <div className="scrollbar max-h-[calc(100dvh-17rem)] overflow-auto p-2">
        {props.path !== "." ? (
          <button
            className="mb-1 flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-slate-500 transition hover:bg-shell-850 hover:text-slate-300"
            onClick={() => props.onOpenDirectory(parentContainerPath(props.path))}
          >
            <ChevronDown className="h-4 w-4 rotate-90" />
            ..
          </button>
        ) : null}
        {props.loading && entries.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading directory
          </div>
        ) : null}
        {[...directories, ...files].map((entry) => (
          <button
            key={entry.path}
            className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-slate-300 transition hover:bg-shell-850"
            onClick={() => entry.type === "directory" ? props.onOpenDirectory(entry.path) : props.onOpenFile(entry.path)}
          >
            {entry.type === "directory" ? <Folder className="h-4 w-4 shrink-0 text-accent-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-500" />}
            <span className="truncate font-mono">{entry.name}</span>
            {entry.type === "file" ? <span className="ml-auto shrink-0 text-xs text-slate-600">{formatBytes(entry.size)}</span> : null}
          </button>
        ))}
        {!props.loading && entries.length === 0 ? <p className="px-2 py-8 text-sm text-slate-500">Directory is empty.</p> : null}
        {props.listing?.truncated ? <p className="px-2 py-3 text-xs text-amberSoft-300">Results truncated.</p> : null}
      </div>
    </section>
  );
}

function Breadcrumbs({ path, onOpenDirectory }: { path: string; onOpenDirectory: (path: string) => void }): JSX.Element {
  const parts = path === "." ? [] : path.split("/").filter(Boolean);

  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
      <button
        className={`rounded-md px-2 py-1 transition hover:bg-shell-850 ${parts.length === 0 ? "text-slate-100" : "text-accent-300"}`}
        onClick={() => onOpenDirectory(".")}
      >
        /workspace
      </button>
      {parts.map((part, index) => {
        const nextPath = parts.slice(0, index + 1).join("/");
        const active = index === parts.length - 1;
        return (
          <span key={nextPath} className="flex min-w-0 items-center gap-1">
            <span className="text-slate-600">/</span>
            <button
              className={`max-w-44 truncate rounded-md px-2 py-1 transition hover:bg-shell-850 ${active ? "text-slate-100" : "text-accent-300"}`}
              onClick={() => onOpenDirectory(nextPath)}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function InlineFileViewer({ file, path, loading, onOpenDirectory }: { file?: ContainerFile; path: string; loading: boolean; onOpenDirectory: (path: string) => void }): JSX.Element {
  const language = languageFromPath(path);
  const parentPath = parentContainerPath(path);

  return (
    <section className="min-h-0 rounded-md border border-shell-700 bg-shell-900">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-shell-700 px-3 py-2">
        <div className="min-w-0 flex-1">
          <Breadcrumbs path={parentPath} onOpenDirectory={onOpenDirectory} />
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <FileText className="h-3.5 w-3.5" />
            <span>{language}</span>
            {file ? <span>{formatBytes(file.size)}</span> : null}
          </div>
          <h3 className="truncate font-mono text-sm font-semibold text-slate-100">{path}</h3>
        </div>
        <button
          className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-shell-700 bg-shell-850 px-3 text-sm text-slate-300 transition hover:bg-shell-800"
          onClick={() => onOpenDirectory(parentPath)}
        >
          <Folder className="h-4 w-4" />
          Directory
        </button>
      </div>
      <div className="scrollbar max-h-[calc(100dvh-13rem)] overflow-auto">
        {loading && !file ? (
          <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading file
          </div>
        ) : file?.kind === "image" && file.dataUrl ? (
          <div className="flex min-h-[20rem] items-center justify-center bg-shell-950 p-4">
            <img
              className="max-h-[calc(100dvh-16rem)] max-w-full rounded-md object-contain"
              src={file.dataUrl}
              alt={path}
            />
          </div>
        ) : (
          <CodeViewer code={file?.content ?? ""} language={language} />
        )}
      </div>
    </section>
  );
}

function QuickPromptPalette(props: {
  inputRef: Ref<HTMLInputElement>;
  query: string;
  items: QuickPromptItem[];
  selectedIndex: number;
  loadingFiles: boolean;
  onQueryChange: (query: string) => void;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
  onSelect: (item: QuickPromptItem | undefined) => void | Promise<void>;
}): JSX.Element {
  const selectedIndex = Math.min(props.selectedIndex, Math.max(0, props.items.length - 1));

  return (
    <div className="fixed inset-0 z-50 bg-shell-950/60 px-3 py-[10dvh] backdrop-blur-sm" onMouseDown={props.onClose}>
      <div
        className="mx-auto flex max-h-[min(34rem,80dvh)] max-w-2xl flex-col overflow-hidden rounded-lg border border-shell-600 bg-shell-900 shadow-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-shell-700 p-2">
          <input
            ref={props.inputRef}
            className="h-11 w-full border-0 bg-transparent px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
            value={props.query}
            placeholder="Open File: /path, Open Container: id, Rename Session: name, Rename Container: name"
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                props.onSelectedIndexChange(Math.min(selectedIndex + 1, Math.max(0, props.items.length - 1)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                props.onSelectedIndexChange(Math.max(0, selectedIndex - 1));
                return;
              }
              if (event.key === "Tab") {
                const input = event.currentTarget;
                const completion = quickPromptCommandCompletion(props.query, props.items[selectedIndex]);
                if (completion) {
                  event.preventDefault();
                  props.onQueryChange(completion.query);
                  window.requestAnimationFrame(() => {
                    input.focus();
                    input.setSelectionRange(completion.cursor, completion.cursor);
                  });
                }
                return;
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                const input = event.currentTarget;
                const deletion = quickPromptCommandDeletion(input, event.key);
                if (deletion) {
                  event.preventDefault();
                  props.onQueryChange(deletion.query);
                  window.requestAnimationFrame(() => {
                    input.focus();
                    input.setSelectionRange(deletion.cursor, deletion.cursor);
                  });
                  return;
                }
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void props.onSelect(props.items[selectedIndex]);
              }
            }}
          />
        </div>
        <div className="flex items-center justify-between border-b border-shell-700 px-3 py-2 text-xs text-slate-500">
          <span>Quick prompt</span>
          {props.loadingFiles ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Indexing files
            </span>
          ) : (
            <span>{props.items.length} action{props.items.length === 1 ? "" : "s"}</span>
          )}
        </div>
        <div className="scrollbar min-h-0 overflow-y-auto p-1">
          {props.items.map((item, index) => (
            <button
              key={item.id}
              className={`flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left transition ${
                index === selectedIndex ? "bg-accent-600/15 text-accent-100" : "text-slate-300 hover:bg-shell-850"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                void props.onSelect(item);
              }}
            >
              <QuickPromptIcon item={item} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.label}</span>
                <span className="block truncate text-xs text-slate-500">{item.detail}</span>
              </span>
            </button>
          ))}
          {!props.loadingFiles && props.items.length === 0 ? (
            <div className="px-3 py-8 text-sm text-slate-500">No actions match.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QuickPromptIcon({ item }: { item: QuickPromptItem }): JSX.Element {
  if (item.kind === "file") {
    return item.fileType === "directory"
      ? <Folder className="h-4 w-4 shrink-0 text-accent-400" />
      : <FileText className="h-4 w-4 shrink-0 text-slate-500" />;
  }
  if (item.kind === "container") return <Terminal className="h-4 w-4 shrink-0 text-accent-400" />;
  if (item.kind === "session") return <MessageSquare className="h-4 w-4 shrink-0 text-slate-500" />;
  if (item.kind === "command") return <Pencil className="h-4 w-4 shrink-0 text-accent-400" />;
  return <Send className="h-4 w-4 shrink-0 text-accent-400" />;
}

function CodeViewer({ code, language }: { code: string; language: string }): JSX.Element {
  const lines = code.split("\n");
  const gutterWidth = String(Math.max(1, lines.length)).length;

  return (
    <pre className="min-w-max p-4 font-mono text-xs leading-5 text-slate-200">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="mr-4 select-none text-right text-slate-600" style={{ width: `${gutterWidth}ch` }}>{index + 1}</span>
          <code className="whitespace-pre">{highlightLine(line, language)}</code>
        </div>
      ))}
    </pre>
  );
}

function highlightLine(line: string, language: string): ReactNode[] {
  const keywords = keywordSet(language);
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|\/\*.*?\*\/|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$-]*\b|[{}()[\].,;:+\-*/%=<>!?|&]+)/g;
  const pieces: ReactNode[] = [];
  let cursor = 0;

  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(line.slice(cursor, index));
    pieces.push(<span key={`${index}-${token}`} className={tokenClass(token, keywords)}>{token}</span>);
    cursor = index + token.length;
  }

  if (cursor < line.length) pieces.push(line.slice(cursor));
  return pieces;
}

function tokenClass(token: string, keywords: Set<string>): string {
  if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")) return "text-slate-500";
  if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return "text-emerald-300";
  if (/^\d/.test(token)) return "text-amberSoft-300";
  if (keywords.has(token)) return "text-accent-300";
  if (/^[{}()[\].,;:+\-*/%=<>!?|&]+$/.test(token)) return "text-slate-500";
  return "text-slate-200";
}

function keywordSet(language: string): Set<string> {
  const common = ["break", "case", "catch", "class", "const", "continue", "default", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "let", "new", "null", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "while"];
  const extra = language === "python"
    ? ["and", "as", "def", "elif", "except", "global", "is", "lambda", "None", "not", "or", "pass", "with", "yield"]
    : language === "rust"
      ? ["async", "await", "enum", "impl", "match", "mod", "mut", "pub", "self", "struct", "trait", "use", "where"]
      : language === "go"
        ? ["chan", "defer", "func", "interface", "map", "package", "range", "select", "struct", "var"]
        : ["async", "await", "interface", "type", "var"];
  return new Set([...common, ...extra]);
}

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    c: "c",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext] ?? "text";
}

function imageMimeTypeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    apng: "image/apng",
    avif: "image/avif",
    gif: "image/gif",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return map[ext] ?? null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractBashStdout(text: string): string {
  if (!text.startsWith("Stdout:\n")) return text;
  const withoutPrefix = text.slice("Stdout:\n".length);
  const stderrIndex = withoutPrefix.indexOf("\n\nStderr:\n");
  if (stderrIndex >= 0) return withoutPrefix.slice(0, stderrIndex);
  const exitCodeIndex = withoutPrefix.indexOf("\n\nExit code:");
  if (exitCodeIndex >= 0) return withoutPrefix.slice(0, exitCodeIndex);
  return withoutPrefix;
}

function parentContainerPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function inferContainerIds(_sessionId: string, displayMessages: DisplayMessage[]): string[] {
  const containers = new Set<string>();
  for (const message of displayMessages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (!toolCall.name.startsWith("container_")) continue;
      const detailsId = detailsContainerId(toolCall.result?.details);
      if (detailsId) containers.add(detailsId);
    }
  }
  return [...containers];
}

function detailsContainerId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const containerId = (value as Record<string, unknown>).containerId;
  return stringValue(containerId);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function containerDisplayName(container: ContainerSummary): string {
  return container.name || container.id.slice(0, 12);
}

function isContainerSleeping(container: ContainerSummary, now: number): boolean {
  const sleepAt = containerSleepAt(container);
  return container.status === "active" && sleepAt !== undefined && now >= sleepAt;
}

function containerStatusInfo(container: ContainerSummary, now: number): {
  label: string;
  tone: "awake" | "sleeping" | "removed" | "unknown";
} {
  if (container.status === "destroyed") return { label: "removed", tone: "removed" };
  const sleepAt = containerSleepAt(container);
  if (sleepAt === undefined) return { label: "active", tone: "unknown" };
  const remaining = sleepAt - now;
  if (remaining <= 0) return { label: "sleep", tone: "sleeping" };
  return { label: `awake ${formatCountdown(remaining)}`, tone: "awake" };
}

function containerSleepAt(container: ContainerSummary): number | undefined {
  if (container.sleepAt !== undefined) return container.sleepAt;
  const lastActivityAt = container.lastActivityAt ?? (container.updatedAt > 0 ? container.updatedAt : undefined);
  if (lastActivityAt === undefined) return undefined;
  return lastActivityAt + (container.sleepAfterMs ?? DEFAULT_CONTAINER_SLEEP_AFTER_MS);
}

function containerTitle(container: ContainerSummary, now: number): string {
  const status = containerStatusInfo(container, now);
  return `${containerDisplayName(container)} (${status.label})\n${container.id}`;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function allSessionContainers(session: SessionSummary): ContainerSummary[] {
  if (session.containerDetails?.length) return session.containerDetails;
  return (session.containers ?? []).map((id) => ({
    id,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  }));
}

function activeSessionContainerIds(session: SessionSummary): string[] {
  return allSessionContainers(session)
    .filter((container) => container.status === "active" && container.deletedAt === undefined)
    .map((container) => container.id);
}

function mergeContainers(current: string[], next: string[]): string[] {
  return [...new Set([...current, ...next])];
}

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || element.getAttribute("contenteditable") === "true";
}

function blurTextEntryElement(element: HTMLInputElement | HTMLTextAreaElement): void {
  element.blur();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}

function buildQuickPromptItems(input: {
  query: string;
  sessions: SessionSummary[];
  currentSessionId: string;
  containers: SelectedContainer[];
  files: QuickPromptFileResult[];
}): QuickPromptItem[] {
  const query = input.query.trim();
  const renameSessionName = quickPromptEnteredCommandArgument(query, "rename-session");
  const renameContainerName = quickPromptEnteredCommandArgument(query, "rename-container");
  const items: QuickPromptItem[] = [];
  const commandQuery = quickPromptMatchedCommandDefinition(query) !== null || quickPromptCommandScoreQuery(query);

  if (commandQuery && !renameSessionName && !renameContainerName) {
    const renameSessionCommand = quickPromptCommandDefinition("rename-session");
    const renameContainerCommand = quickPromptCommandDefinition("rename-container");

    if (input.currentSessionId && renameSessionCommand) {
      items.push({
        id: "command-template:rename-session",
        kind: "command",
        label: renameSessionCommand.prefix.trimEnd(),
        detail: renameSessionCommand.detail,
        command: "rename-session",
        argument: "",
      });
    }

    if (renameContainerCommand) {
      for (const container of input.containers) {
        items.push({
          id: `command-template:rename-container:${container.containerId}`,
          kind: "command",
          label: renameContainerCommand.prefix.trimEnd(),
          detail: `${renameContainerCommand.detail}: ${container.containerId.slice(0, 12)}`,
          command: "rename-container",
          argument: "",
          sessionId: container.sessionId,
          containerId: container.containerId,
        });
      }
    }
  }

  if (input.currentSessionId && renameSessionName) {
    items.push({
      id: `command:rename-session:${renameSessionName}`,
      kind: "command",
      label: `Rename Session: ${renameSessionName}`,
      detail: `Current session ${input.currentSessionId.slice(0, 8)}`,
      command: "rename-session",
      argument: renameSessionName,
    });
  }

  if (renameContainerName) {
    for (const container of input.containers) {
      items.push({
        id: `command:rename-container:${container.containerId}:${renameContainerName}`,
        kind: "command",
        label: `Rename Container: ${renameContainerName}`,
        detail: `Container ${container.containerId.slice(0, 12)}`,
        command: "rename-container",
        argument: renameContainerName,
        sessionId: container.sessionId,
        containerId: container.containerId,
      });
    }
  }

  if (input.containers.length > 0) {
    const directPath = quickPromptEnteredPath(query, "open file");
    if (directPath) {
      for (const container of input.containers) {
        items.push({
          id: `file-direct:${container.containerId}:${directPath}`,
          kind: "file",
          label: `Open File: ${directPath}`,
          detail: `${container.containerId} / try exact path`,
          sessionId: container.sessionId,
          containerId: container.containerId,
          path: directPath,
          fileType: "file",
        });
      }
    }

    for (const file of input.files) {
      const action = file.type === "directory" ? "Open Directory" : "Open File";
      items.push({
        id: `file:${file.containerId}:${file.path}`,
        kind: "file",
        label: `${action}: ${file.path}`,
        detail: `${file.containerId} / ${file.type === "directory" ? "directory" : formatBytes(file.size)}`,
        sessionId: file.sessionId,
        containerId: file.containerId,
        path: file.path,
        fileType: file.type,
      });
    }
  }

  for (const session of input.sessions) {
    const sessionTitle = formatSessionTitle(session);
    for (const container of allSessionContainers(session).filter((container) => container.status === "active" && container.deletedAt === undefined)) {
      const displayName = containerDisplayName(container);
      items.push({
        id: `container:${session.id}:${container.id}`,
        kind: "container",
        label: `Open Container: ${displayName}`,
        detail: `Session: ${sessionTitle} (${session.id.slice(0, 8)}) / ${container.id}`,
        sessionId: session.id,
        containerId: container.id,
      });
    }

    items.push({
      id: `session:${session.id}`,
      kind: "session",
      label: `Open Session: ${sessionTitle}`,
      detail: `${session.status} / ${session.id.slice(0, 8)} / ${session.messageCount} ${session.messageCount === 1 ? "event" : "events"}`,
      sessionId: session.id,
    });
  }

  return rankQuickPromptItems(items, query).slice(0, 80);
}

function rankQuickPromptItems(items: QuickPromptItem[], query: string): QuickPromptItem[] {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: quickPromptScore(`${item.label} ${item.detail}`, query) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
}

function quickPromptScore(label: string, query: string): number {
  const normalizedLabel = normalizeSearchText(label);
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    const index = normalizedLabel.indexOf(token);
    if (index >= 0) {
      total += index;
      continue;
    }

    const fuzzy = fuzzySubsequenceScore(normalizedLabel, token);
    if (fuzzy === null) return Number.POSITIVE_INFINITY;
    total += fuzzy + 100;
  }
  return total;
}

function fuzzySubsequenceScore(label: string, token: string): number | null {
  let labelIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let gaps = 0;

  for (const char of token) {
    const matchIndex = label.indexOf(char, labelIndex);
    if (matchIndex < 0) return null;
    if (firstMatch < 0) firstMatch = matchIndex;
    if (lastMatch >= 0) gaps += matchIndex - lastMatch - 1;
    lastMatch = matchIndex;
    labelIndex = matchIndex + 1;
  }

  return firstMatch + gaps;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|\s)(?:\.\/|\/)+/g, "$1")
    .replace(/[\\/_:-]+/g, " ");
}

function quickPromptCommandCompletion(query: string, item: QuickPromptItem | undefined): { query: string; cursor: number } | null {
  const command = quickPromptItemCommandPrefix(item) ?? quickPromptMatchedCommandPrefix(query);
  if (!command) return null;

  const argument = quickPromptCommandArgument(query, command);
  const completedQuery = `${command}${argument}`;
  return {
    query: completedQuery,
    cursor: argument ? completedQuery.length : command.length,
  };
}

function quickPromptCommandDeletion(input: HTMLInputElement, key: "Backspace" | "Delete"): { query: string; cursor: number } | null {
  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? 0;
  const command = quickPromptCommandPrefixes().find((prefix) => input.value.startsWith(prefix));
  if (!command) return null;

  if (selectionStart === 0 && selectionEnd === command.length) {
    return {
      query: input.value.slice(command.length),
      cursor: 0,
    };
  }

  if (selectionStart !== selectionEnd) return null;
  if (key === "Backspace" && selectionStart === command.length) {
    return {
      query: input.value.slice(command.length),
      cursor: 0,
    };
  }
  if (key === "Delete" && selectionStart === 0) {
    return {
      query: input.value.slice(command.length),
      cursor: 0,
    };
  }

  return null;
}

function quickPromptCommandArgument(query: string, command: string): string {
  const trimmedStart = query.trimStart();
  const matchedCommand = quickPromptMatchedCommandPrefix(trimmedStart);
  if (matchedCommand) return trimmedStart.slice(matchedCommand.length).trimStart();

  const commandWords = normalizeSearchText(command).split(/\s+/).filter(Boolean);
  const queryWords = normalizeSearchText(trimmedStart).split(/\s+/).filter(Boolean);
  if (!queryWords.length) return "";

  const partialCommandWordCount = queryWords.findIndex((word, index) => {
    const commandWord = commandWords[index];
    return !commandWord || (!commandWord.startsWith(word) && word !== commandWord);
  });
  if (partialCommandWordCount < 0) return "";
  if (partialCommandWordCount === 0) return trimmedStart;

  return trimmedStart.split(/\s+/).slice(partialCommandWordCount).join(" ");
}

function quickPromptMatchedCommandPrefix(query: string): string | null {
  return quickPromptMatchedCommandDefinition(query)?.prefix ?? null;
}

function quickPromptItemCommandPrefix(item: QuickPromptItem | undefined): string | null {
  if (!item) return null;
  if (item.kind === "file") return quickPromptCommandDefinition(item.fileType === "directory" ? "open-directory" : "open-file")?.prefix ?? null;
  if (item.kind === "container") return quickPromptCommandDefinition("open-container")?.prefix ?? null;
  if (item.kind === "session") return quickPromptCommandDefinition("open-session")?.prefix ?? null;
  if (item.kind === "command") return quickPromptCommandDefinition(item.command)?.prefix ?? null;
  return null;
}

function quickPromptCommandPrefixes(): string[] {
  return quickPromptCommands.map((command) => command.prefix);
}

function quickPromptCommandDefinition(id: QuickPromptCommandId): QuickPromptCommandDefinition | undefined {
  return quickPromptCommands.find((command) => command.id === id);
}

function quickPromptMatchedCommandDefinition(query: string): QuickPromptCommandDefinition | null {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return null;
  return quickPromptCommands.find((command) => (
    quickPromptCommandTriggers(command).some((trigger) => {
      const normalizedTrigger = normalizeSearchText(trigger).trim();
      return normalizedTrigger === normalizedQuery
        || normalizedTrigger.startsWith(normalizedQuery)
        || normalizedQuery.startsWith(`${normalizedTrigger} `);
    })
  )) ?? null;
}

function quickPromptCommandTriggers(command: QuickPromptCommandDefinition): string[] {
  return [command.prefix, ...(command.aliases ?? [])];
}

function quickPromptCommandScoreQuery(query: string): boolean {
  if (!query.trim()) return true;
  return quickPromptCommands.some((command) => quickPromptScore(`${command.prefix} ${command.detail}`, query) < Number.POSITIVE_INFINITY);
}

function quickPromptEnteredCommandArgument(query: string, commandId: QuickPromptCommandId): string {
  const command = quickPromptCommandDefinition(commandId);
  if (!command) return "";

  const trimmedStart = query.trimStart();
  if (commandId === "rename-session" && /^rename\s+container(?:\s*:|\s+|\s*$)/i.test(trimmedStart)) return "";

  for (const trigger of quickPromptCommandTriggers(command)) {
    const pattern = trigger.trim().replace(/:\s*$/, "").replace(/\s+/g, "\\s+");
    const match = trimmedStart.match(new RegExp(`^${pattern}(?:\\s*:\\s*|\\s+)(.+)$`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function quickPromptEnteredPath(query: string, action: string): string {
  const normalizedAction = action.replace(/\s+/g, "\\s+");
  const match = query.match(new RegExp(`^${normalizedAction}(?:\\s*:\\s*|\\s+)(.+)$`, "i"));
  return match?.[1] ? normalizeQuickFilePath(match[1]) : "";
}

function quickPromptFileSearchQuery(query: string): string {
  const directPath = quickPromptEnteredPath(query, "open file") || quickPromptEnteredPath(query, "open directory");
  if (directPath) return directPath;
  if (/^(?:open\s+file|open\s+directory)\s*:?\s*$/i.test(query)) return "";
  const matchedCommand = quickPromptMatchedCommandDefinition(query);
  if (matchedCommand?.id === "rename-session" || matchedCommand?.id === "rename-container") return "";
  return query.trim();
}

function containerFindSearchInput(query: string): { path: string; name?: string } {
  const normalized = normalizeQuickFilePath(query);
  if (!normalized) return { path: "." };

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return { path: "." };

  const queryEndsAtDirectory = normalized.endsWith("/");
  const pathSegments = queryEndsAtDirectory ? segments : segments.slice(0, -1);
  const path = pathSegments.length ? pathSegments.join("/") : ".";
  const lastSegment = queryEndsAtDirectory ? "" : segments.at(-1)?.trim() ?? "";

  return lastSegment ? { path, name: `*${lastSegment}*` } : { path };
}

function filterQuickFiles(files: QuickPromptFileResult[], query: string): QuickPromptFileResult[] {
  const normalizedQuery = normalizeQuickFilePath(query).toLowerCase();
  const matches = normalizedQuery
    ? files.filter((file) => quickFileMatches(file.path, normalizedQuery))
    : files;

  return matches
    .sort((a, b) => quickFileScore(a.path, normalizedQuery) - quickFileScore(b.path, normalizedQuery))
    .slice(0, 30);
}

function normalizeQuickFilePath(path: string): string {
  const withoutLeadingSlash = path.trim().replace(/^\/+/, "");
  return withoutLeadingSlash.startsWith("workspace/")
    ? withoutLeadingSlash.slice("workspace/".length)
    : withoutLeadingSlash;
}

function createMarkdownComponents(
  containerIds: string[],
  onOpenContainerFile: (link: ContainerFileLink) => void,
): Components {
  return {
    a({ href, children, ...props }) {
      const containerLink = parseContainerFileLink(href, containerIds);
      if (!containerLink) {
        return <a href={href} {...props}>{children}</a>;
      }
      return (
        <button
          type="button"
          className="font-medium text-accent-300 underline decoration-accent-400/50 underline-offset-2 transition hover:text-accent-200"
          title={`${containerLink.containerId}:${containerLink.path}`}
          onClick={() => onOpenContainerFile(containerLink)}
        >
          {children}
        </button>
      );
    },
  };
}

function parseContainerFileLink(href: string | undefined, containerIds: string[]): ContainerFileLink | null {
  if (!href) return null;
  const separatorIndex = href.indexOf(":");
  if (separatorIndex <= 0) return null;
  const containerId = href.slice(0, separatorIndex);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(containerId) || !containerIds.includes(containerId)) return null;

  const rawPath = href.slice(separatorIndex + 1);
  const pathWithoutFragment = rawPath.split("#", 1)[0] ?? "";
  const pathWithoutQuery = pathWithoutFragment.split("?", 1)[0] ?? "";
  const path = normalizeQuickFilePath(decodeContainerLinkPath(pathWithoutQuery));
  return path ? { containerId, path } : null;
}

function decodeContainerLinkPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function quickFileMatches(path: string, query: string): boolean {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.includes(query)) return true;

  let queryIndex = 0;
  for (const char of normalizedPath) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function quickFileScore(path: string, query: string): number {
  if (!query) return path.length;
  const normalizedPath = path.toLowerCase();
  const index = normalizedPath.indexOf(query);
  if (index >= 0) return index * 10 + path.length;
  return 10_000 + path.length;
}

function PromptHistoryReveal({ promptHistory, visibleMessages }: { promptHistory: SessionResponse["promptHistory"] | null; visibleMessages: DisplayMessage[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const content = formatPromptHistoryBeforeFirstVisibleMessage(promptHistory, visibleMessages);
  if (!content) return null;

  return (
    <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none justify-center">
        <span className="rounded-md px-2 py-1 text-xs text-slate-600 transition group-open:text-slate-400 hover:bg-shell-850 hover:text-slate-400">
          {open ? "hide system prompt" : "see system prompt"}
        </span>
      </summary>
      <PromptHistoryBlock label="Prompt history" content={content} />
    </details>
  );
}

function PromptHistoryBlock({ label, content }: { label: string; content: string }): JSX.Element {
  return (
    <section className="rounded-md border border-shell-700 bg-shell-900/70 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <pre className="scrollbar max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">
        {content}
      </pre>
    </section>
  );
}

function ChatMessage({
  message,
  containerIds,
  onOpenContainerFile,
}: {
  message: DisplayMessage;
  containerIds: string[];
  onOpenContainerFile: (link: ContainerFileLink) => void;
}): JSX.Element {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const isSystem = message.role === "system";
  const markdownComponents = createMarkdownComponents(containerIds, onOpenContainerFile);
  if (isSystem) return <PromptHistoryBlock label="System" content={message.content} />;

  if (isError) {
    return (
      <article className="flex justify-start gap-3">
        <Avatar role={message.role} />
        <div className="min-w-0 max-w-[84%] rounded-lg bg-red-950/55 px-4 py-3 text-red-100 ring-1 ring-red-800">
          {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={(url) => url} className="markdown text-sm">{message.content}</ReactMarkdown> : null}
        </div>
      </article>
    );
  }

  if (!isUser && !isError) {
    return (
      <article className="w-full min-w-0 py-1">
        {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={(url) => url} className="markdown text-[0.95rem] text-slate-100">{message.content}</ReactMarkdown> : null}
        {message.toolCalls?.length ? (
          <div className="mt-4 flex flex-col gap-2">
            {message.toolCalls.map((toolCall, index) => (
              <ToolCall key={`${toolCall.id}-${index}`} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className="flex justify-end gap-3">
      <div className="min-w-0 max-w-[84%] rounded-lg bg-slate-100 px-4 py-3 text-shell-950">
        {message.content ? <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p> : null}
        {message.toolCalls?.length ? (
          <div className="mt-3 flex flex-col gap-2">
            {message.toolCalls.map((toolCall, index) => (
              <ToolCall key={`${toolCall.id}-${index}`} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ToolCall({ toolCall }: { toolCall: ToolCallInfo }): JSX.Element {
  const hasError = toolCall.status === "error" || toolCall.result?.isError;
  const complete = toolCall.status === "complete" || Boolean(toolCall.result && !hasError);
  return (
    <details className={`border-l-2 py-1 pl-3 ${hasError ? "border-red-600" : complete ? "border-mint-600" : "border-accent-600"}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-slate-300">
        {hasError ? <X className="h-4 w-4 text-red-300" /> : complete ? <Check className="h-4 w-4 text-mint-500" /> : <Circle className="h-3 w-3 fill-accent-500 text-accent-500" />}
        <span className="truncate font-medium">{formatToolCallHeader(toolCall.name, toolCall.params)}</span>
        <ChevronDown className="ml-auto h-4 w-4 text-slate-500" />
      </summary>
      <pre className="scrollbar mt-3 max-h-72 overflow-auto whitespace-pre-wrap border-l border-shell-700 pl-3 text-xs leading-5 text-slate-400">
        {JSON.stringify({ arguments: toolCall.params, result: toolCall.result?.content, details: toolCall.result?.details }, null, 2)}
      </pre>
    </details>
  );
}

function Avatar({ role }: { role: DisplayMessage["role"] }): JSX.Element {
  const Icon = role === "user" ? User : role === "error" ? AlertTriangle : Bot;
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-shell-800 ring-1 ring-shell-700">
      <Icon className="h-4 w-4 text-slate-300" />
    </div>
  );
}

interface LoginScreenProps {
  settingsError: string | null;
  loginStatus: LoginStatus;
  loginMessage: string;
  loginUser: string | null;
  onLogin: () => void;
}

function LoginScreen(props: LoginScreenProps): JSX.Element {
  const isLoggingIn = props.loginStatus === "starting" || props.loginStatus === "waiting";
  const messageTone = props.loginStatus === "error"
    ? "border-red-800 bg-red-950/35 text-red-100"
    : props.loginStatus === "approved"
      ? "border-emerald-800 bg-emerald-950/25 text-emerald-100"
      : "border-shell-700 bg-shell-850 text-slate-300";

  return (
    <main className="flex h-dvh min-h-[32rem] items-center justify-center bg-shell-950 px-5 text-slate-100">
      <div className="flex w-full max-w-lg flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-3 text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
          <Bot className="h-5 w-5 text-accent-500" />
          Clawflare Web
        </div>
        <button
          className="primary-btn min-w-52"
          disabled={isLoggingIn}
          onClick={props.onLogin}
        >
          {isLoggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          <span>Login with GitHub</span>
        </button>
        {props.settingsError ? <p className="max-w-xl text-sm text-red-300">{props.settingsError}</p> : null}
        {props.loginMessage ? (
          <div className={`w-full rounded-md border p-4 text-sm ${messageTone}`}>
            <p className="font-medium">{props.loginMessage}</p>
            {props.loginStatus === "approved" && props.loginUser ? <p className="mt-1 text-slate-400">Signed in as {props.loginUser}.</p> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}

interface SettingsPageProps {
  section: SettingsSection;
  settingsError: string | null;
  loginStatus: LoginStatus;
  loginMessage: string;
  loginUser: string | null;
  providers: ProviderInfo[];
  workspaceProviders: WorkspaceProvider[];
  providerModels: ProviderModelInfo[];
  selectedProvider: string;
  selectedModel: string;
  showModelForm: boolean;
  selectedProviderInfo?: ProviderInfo;
  models: Model[];
  defaultModelId?: string;
  modelSecrets: Record<string, string>;
  availableEgress: EgressHandlerInfo[];
  configuredEgress: EgressHandlerInfo[];
  selectedEgress: string;
  showEgressForm: boolean;
  selectedEgressInfo?: EgressHandlerInfo;
  egressSecrets: Record<string, string>;
  egressConfig: Record<string, string>;
  egressEnabled: boolean;
  sessionsTotal: number;
  isConfigured: boolean;
  onSectionChange: (section: SettingsSection) => void;
  onLogin: () => void;
  onSignOut: () => void;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onToggleModelForm: () => void;
  onDeleteProvider: (id: string) => void;
  onModelSecretChange: (key: string, value: string) => void;
  onCreateModel: () => void;
  onDeleteModel: (id: string) => void;
  onSetDefaultModel: (id: string | null) => void;
  onEgressChange: (id: string) => void;
  onToggleEgressForm: () => void;
  onEgressSecretChange: (key: string, value: string) => void;
  onEgressConfigChange: (key: string, value: string) => void;
  onEgressEnabledChange: (enabled: boolean) => void;
  onConfigureEgress: () => void;
  onToggleEgress: (id: string, enabled: boolean) => void;
  onDeleteEgress: (id: string) => void;
  onDeleteAll: () => void;
}

const settingsSections: Array<{ id: SettingsSection; label: string; icon: JSX.Element }> = [
  { id: "providers", label: "Providers", icon: <KeyRound className="h-4 w-4" /> },
  { id: "egress", label: "Egress", icon: <Shield className="h-4 w-4" /> },
  { id: "models", label: "Models", icon: <Database className="h-4 w-4" /> },
  { id: "account", label: "Account", icon: <User className="h-4 w-4" /> },
  { id: "data", label: "Data", icon: <Monitor className="h-4 w-4" /> },
];

function SettingsPage(props: SettingsPageProps): JSX.Element {
  return (
    <section className="scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-4 sm:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-500">Manage provider credentials, default model selection, egress handlers, account access, and workspace data.</p>
        </div>
        <div className="grid min-h-[22rem] gap-5 lg:min-h-[32rem] lg:grid-cols-[13rem_1fr]">
          <nav className="grid grid-cols-2 gap-2 sm:flex sm:flex-row sm:overflow-x-auto lg:flex-col lg:overflow-visible">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                className={`flex h-10 w-full shrink-0 items-center gap-2 rounded-md border px-3 text-sm transition ${
                  props.section === section.id
                    ? "border-accent-600 bg-accent-600/20 text-accent-300"
                    : "border-shell-700 bg-shell-850 text-slate-300 hover:bg-shell-800"
                }`}
                onClick={() => props.onSectionChange(section.id)}
              >
                {section.icon}
                {section.label}
              </button>
            ))}
          </nav>
          <div className="rounded-md border border-shell-700 bg-shell-900 p-3 sm:p-4">
            {props.section === "providers" ? <ProvidersPanel {...props} /> : null}
            {props.section === "egress" ? <EgressPanel {...props} /> : null}
            {props.section === "models" ? <ModelsPanel {...props} /> : null}
            {props.section === "account" ? <AccountPanel {...props} /> : null}
            {props.section === "data" ? <DataPanel sessionsTotal={props.sessionsTotal} onDeleteAll={props.onDeleteAll} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function AccountPanel(props: SettingsPageProps): JSX.Element {
  return (
    <PanelStack>
      <SectionTitle icon={<User className="h-4 w-4" />} title="Account" />
      {props.settingsError ? <p className="text-sm text-red-300">{props.settingsError}</p> : null}
      {!props.isConfigured ? (
        <button className="primary-btn w-full max-w-56 self-start" disabled={props.loginStatus === "starting" || props.loginStatus === "waiting"} onClick={props.onLogin}>
          {props.loginStatus === "starting" || props.loginStatus === "waiting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Login with GitHub
        </button>
      ) : null}
      {props.loginMessage ? (
        <div className={`rounded-md border p-3 text-sm ${props.loginStatus === "approved" ? "border-emerald-800 bg-emerald-950/25 text-emerald-100" : props.loginStatus === "error" ? "border-red-800 bg-red-950/35 text-red-100" : "border-shell-700 bg-shell-850 text-slate-300"}`}>
          <p className="font-medium">{props.loginMessage}</p>
          {props.loginStatus === "approved" && props.loginUser ? <p className="mt-1 text-slate-400">Signed in as {props.loginUser}.</p> : null}
        </div>
      ) : null}
      {props.isConfigured ? (
        <button className="flex h-10 w-full max-w-56 items-center justify-center gap-2 self-start rounded-md bg-red-100 px-3 text-sm font-medium text-red-950 transition hover:bg-red-50" onClick={props.onSignOut}>
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      ) : null}
    </PanelStack>
  );
}

function ModelsPanel(props: SettingsPageProps): JSX.Element {
  const hasModels = props.models.length > 0;
  const hasProviders = props.workspaceProviders.length > 0;

  return (
    <PanelStack>
      <SectionTitle icon={<Database className="h-4 w-4" />} title="Default model" />
      {!hasModels ? (
        <InfoBox>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">No models configured</p>
              <p className="mt-1 text-sm text-slate-500">
                {hasProviders ? "Add a model for one of your configured providers before choosing a default." : "Configure a provider before choosing a default model."}
              </p>
            </div>
            <button className="secondary-btn self-start" onClick={() => props.onSectionChange("providers")}>
              <KeyRound className="h-4 w-4" />
              {hasProviders ? "Add model" : "Configure providers"}
            </button>
          </div>
        </InfoBox>
      ) : null}
      {hasModels && !props.defaultModelId ? (
        <InfoBox>
          <p className="text-sm font-medium text-slate-200">No default model selected</p>
          <p className="mt-1 text-sm text-slate-500">Choose one of your configured models to use automatically for new chats.</p>
        </InfoBox>
      ) : null}
      {props.models.map((connection) => (
        <Row key={connection.id}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{connection.displayName || `${connection.provider}/${connection.modelName}`}</p>
            <p className="truncate text-xs text-slate-500">{connection.provider}/{connection.modelName}</p>
          </div>
          <IconButton title="Set default" active={connection.id === props.defaultModelId} onClick={() => props.onSetDefaultModel(connection.id)}>
            <Check className="h-4 w-4" />
          </IconButton>
        </Row>
      ))}
    </PanelStack>
  );
}

function ProvidersPanel(props: SettingsPageProps): JSX.Element {
  return (
    <PanelStack>
      <SectionTitle icon={<KeyRound className="h-4 w-4" />} title="Configured providers" />
      {props.workspaceProviders.map((provider) => (
        <Row key={provider.id}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{provider.providerDisplayName || providerLabel(props.providers, provider.provider)}</p>
            <p className="truncate text-xs text-slate-500">
              {provider.provider}
              {provider.configuredSecrets.length ? ` · ${provider.configuredSecrets.length} secret${provider.configuredSecrets.length === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <IconButton title="Delete provider" onClick={() => props.onDeleteProvider(provider.id)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </Row>
      ))}
      {props.workspaceProviders.length === 0 ? <p className="text-sm text-slate-500">No providers configured.</p> : null}
      <button className="secondary-btn self-start" onClick={props.onToggleModelForm}>
        {props.showModelForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        Add Provider
      </button>

      {props.showModelForm ? (
        <div className="flex flex-col gap-4 rounded-md border border-shell-700 bg-shell-850 p-4">
          <SectionTitle icon={<Plus className="h-4 w-4" />} title="Add provider" />
          <Field label="Provider">
            <select className="input" value={props.selectedProvider} onChange={(event) => props.onProviderChange(event.target.value)}>
              {props.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
              ))}
            </select>
          </Field>
          {props.selectedProviderInfo?.requiredSecrets.map((secret) => (
            <Field key={secret} label={`${secret} required`}>
              <input className="input" type="password" value={props.modelSecrets[secret] ?? ""} onChange={(event) => props.onModelSecretChange(secret, event.target.value)} />
            </Field>
          ))}
          {props.selectedProviderInfo?.optionalSecrets.map((secret) => (
            <Field key={secret} label={`${secret} optional`}>
              <input className="input" type="password" value={props.modelSecrets[secret] ?? ""} onChange={(event) => props.onModelSecretChange(secret, event.target.value)} />
            </Field>
          ))}
          <Field label="Default model">
            <select className="input" value={props.selectedModel} onChange={(event) => props.onModelChange(event.target.value)}>
              {props.providerModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name} ({model.id})</option>
              ))}
            </select>
          </Field>
          <button className="primary-btn self-start" disabled={!props.selectedProvider || !props.selectedModel} onClick={props.onCreateModel}>
            <Hammer className="h-4 w-4" />
            Add
          </button>
        </div>
      ) : null}
    </PanelStack>
  );
}

function EgressPanel(props: SettingsPageProps): JSX.Element {
  return (
    <PanelStack>
      <SectionTitle icon={<Shield className="h-4 w-4" />} title="Configured egress" />
      {props.configuredEgress.filter((handler) => handler.updatedAt > 0).map((handler) => (
        <Row key={handler.egressHandlerId}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{handler.name}</p>
            <p className="truncate text-xs text-slate-500">{handler.domains.join(", ")}</p>
          </div>
          <IconButton title={handler.enabled ? "Disable" : "Enable"} active={handler.enabled} onClick={() => props.onToggleEgress(handler.egressHandlerId, !handler.enabled)}>
            <Power className="h-4 w-4" />
          </IconButton>
          <IconButton title="Delete" onClick={() => props.onDeleteEgress(handler.egressHandlerId)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </Row>
      ))}

      <button className="secondary-btn self-start" onClick={props.onToggleEgressForm}>
        {props.showEgressForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        Add Provider
      </button>

      {props.showEgressForm ? (
        <div className="flex flex-col gap-4 rounded-md border border-shell-700 bg-shell-850 p-4">
          <SectionTitle icon={<Plus className="h-4 w-4" />} title="Add provider" />
          <Field label="Handler">
            <select className="input" value={props.selectedEgress} onChange={(event) => props.onEgressChange(event.target.value)}>
              {props.availableEgress.map((handler) => (
                <option key={handler.egressHandlerId} value={handler.egressHandlerId}>{handler.name}</option>
              ))}
            </select>
          </Field>
          {props.selectedEgressInfo ? <p className="text-sm text-slate-400">{props.selectedEgressInfo.description}</p> : null}
          {props.selectedEgressInfo?.requiredSecrets.map((secret) => (
            <Field key={secret} label={`${secret} required`}>
              <input className="input" type="password" value={props.egressSecrets[secret] ?? ""} onChange={(event) => props.onEgressSecretChange(secret, event.target.value)} />
            </Field>
          ))}
          {props.selectedEgressInfo?.optionalSecrets.map((secret) => (
            <Field key={secret} label={`${secret} optional`}>
              <input className="input" type="password" value={props.egressSecrets[secret] ?? ""} onChange={(event) => props.onEgressSecretChange(secret, event.target.value)} />
            </Field>
          ))}
          {schemaProperties(props.selectedEgressInfo).map(([key, choices]) => (
            <Field key={key} label={key}>
              {choices.length ? (
                <select className="input" value={props.egressConfig[key] ?? ""} onChange={(event) => props.onEgressConfigChange(key, event.target.value)}>
                  <option value="">Default</option>
                  {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              ) : (
                <input className="input" value={props.egressConfig[key] ?? ""} onChange={(event) => props.onEgressConfigChange(key, event.target.value)} placeholder="optional" />
              )}
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={props.egressEnabled} onChange={(event) => props.onEgressEnabledChange(event.target.checked)} />
            Enable immediately
          </label>
          <button className="primary-btn self-start" disabled={!props.selectedEgress} onClick={props.onConfigureEgress}>
            <Hammer className="h-4 w-4" />
            Configure
          </button>
        </div>
      ) : null}
    </PanelStack>
  );
}

function DataPanel(props: { sessionsTotal: number; onDeleteAll: () => void }): JSX.Element {
  return (
    <PanelStack>
      <SectionTitle icon={<Monitor className="h-4 w-4" />} title="Data" />
      <InfoBox>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-200">Sessions</p>
            <p className="mt-1 text-sm text-slate-500">{props.sessionsTotal} session{props.sessionsTotal === 1 ? "" : "s"} stored for this workspace.</p>
          </div>
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-red-900/70 px-3 text-sm text-red-300 transition hover:border-red-700 hover:bg-red-950/45 hover:text-red-100 disabled:cursor-not-allowed disabled:border-shell-700 disabled:text-slate-600 disabled:hover:bg-transparent"
            disabled={props.sessionsTotal === 0}
            onClick={props.onDeleteAll}
          >
            <Trash2 className="h-4 w-4" />
            Delete All
          </button>
        </div>
      </InfoBox>
    </PanelStack>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: JSX.Element;
  title: string;
  body: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mx-auto mt-16 max-w-md text-center sm:mt-24">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-shell-850 text-accent-500 ring-1 ring-shell-700">{icon}</div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
      {action}
    </div>
  );
}

function Thinking(): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-accent-500" />
      Thinking
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <pre className="min-w-0 flex-1 whitespace-pre-wrap font-sans">{message}</pre>
      <button title="Dismiss" onClick={onDismiss}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function IconButton({ title, active = false, children, onClick }: { title: string; active?: boolean; children: JSX.Element; onClick: () => void }): JSX.Element {
  return (
    <button
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition ${active ? "border-accent-600 bg-accent-600/20 text-accent-500" : "border-shell-700 bg-shell-850 text-slate-300 hover:bg-shell-800"}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusPill({ status, connected }: { status: string; connected: boolean }): JSX.Element {
  return (
    <div className="hidden items-center gap-2 rounded-full border border-shell-700 bg-shell-850 px-3 py-1.5 text-xs text-slate-300 sm:flex">
      <span className={`h-2 w-2 rounded-full ${connected ? "bg-mint-500" : "bg-amberSoft-500"}`} />
      <span className="max-w-40 truncate">{status}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function PanelStack({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function SectionTitle({ icon, title }: { icon: JSX.Element; title: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 pt-2 text-sm font-semibold text-slate-200">
      {icon}
      {title}
    </div>
  );
}

function Row({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex items-start gap-2 rounded-md border border-shell-700 bg-shell-850 p-3 sm:items-center">{children}</div>;
}

function InfoBox({ children }: { children: ReactNode }): JSX.Element {
  return <div className="rounded-md border border-shell-700 bg-shell-850 p-3">{children}</div>;
}

function pruneEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && entry !== undefined && entry !== null)) as T;
}

function oldestEventSequence(events: Array<{ sequence: number }>): number | null {
  return events.reduce<number | null>((oldest, event) => (
    oldest === null || event.sequence < oldest ? event.sequence : oldest
  ), null);
}

function isNearBottom(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
}

function mergeCurrentTurnMessages(
  current: DisplayMessage[],
  serverMessages: DisplayMessage[],
  promptContent: string,
  optimistic: DisplayMessage,
): DisplayMessage[] {
  if (serverMessages.length === 0) return hasMatchingUserMessage(current, promptContent) ? current : [...current, optimistic];

  const currentPromptIndex = findLastUserMessageIndex(current, promptContent);
  const serverPromptIndex = findFirstUserMessageIndex(serverMessages, promptContent);
  if (currentPromptIndex !== -1 && serverPromptIndex !== -1) {
    return [
      ...current.slice(0, currentPromptIndex),
      ...serverMessages.slice(serverPromptIndex),
    ];
  }

  return hasMatchingUserMessage(current, promptContent) ? current : [...current, optimistic];
}

function hasMatchingUserMessage(messages: DisplayMessage[], content: string): boolean {
  return findLastUserMessageIndex(messages, content) !== -1;
}

function findLastUserMessageIndex(messages: DisplayMessage[], content: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim() === content) return index;
  }
  return -1;
}

function findFirstUserMessageIndex(messages: DisplayMessage[], content: string): number {
  return messages.findIndex((message) => message.role === "user" && message.content.trim() === content);
}

function formatPromptHistoryBeforeFirstVisibleMessage(
  promptHistory: SessionResponse["promptHistory"] | null,
  visibleMessages: DisplayMessage[],
): string {
  if (!promptHistory?.systemPrompt) return "";

  const firstVisibleUser = visibleMessages.find((message) => message.role === "user");
  const firstVisibleUserText = firstVisibleUser?.content.trim();
  const firstVisibleHistoryIndex = firstVisibleUserText
    ? promptHistory.messages.findIndex((message) =>
        agentMessageRole(message) === "user" && agentMessageText(message).trim() === firstVisibleUserText
      )
    : -1;
  const historyMessages = firstVisibleHistoryIndex >= 0
    ? promptHistory.messages.slice(0, firstVisibleHistoryIndex)
    : promptHistory.messages;

  return [
    formatPromptHistoryEntry("system", promptHistory.systemPrompt),
    ...historyMessages.map((message) => formatPromptHistoryEntry(agentMessageLabel(message), agentMessageText(message))),
  ].filter(Boolean).join("\n\n");
}

function formatPromptHistoryEntry(label: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `--- ${label} ---\n${trimmed}`;
}

function agentMessageRole(message: unknown): string {
  return isUnknownRecord(message) && typeof message.role === "string" ? message.role : "message";
}

function agentMessageLabel(message: unknown): string {
  if (!isUnknownRecord(message)) return "message";
  const role = agentMessageRole(message);
  if (role !== "toolResult") return role;
  return typeof message.toolName === "string" ? `toolResult: ${message.toolName}` : role;
}

function agentMessageText(message: unknown): string {
  if (!isUnknownRecord(message)) return JSON.stringify(message, null, 2);
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((part) => {
    if (!isUnknownRecord(part)) return JSON.stringify(part);
    if (part.type === "text" && typeof part.text === "string") return part.text;
    return JSON.stringify(part, null, 2);
  }).join("\n");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyProcessingError(message: string): boolean {
  return message.toLowerCase().includes("already processing");
}

function providerLabel(providers: ProviderInfo[], providerId: string): string {
  return providers.find((provider) => provider.id === providerId)?.name || providerId;
}

function schemaProperties(handler?: EgressHandlerInfo): Array<[string, string[]]> {
  const properties = handler?.configSchema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([key, schema]) => [
    key,
    Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === "string") : [],
  ]);
}

function formatKillResult(result: { sessionId: string; workflowTerminated: boolean; destroyedContainers: string[]; errors: string[] }): string {
  return [
    `Session ${result.sessionId.slice(0, 8)} killed.`,
    result.workflowTerminated ? "Workflow terminated." : "Workflow was not running.",
    result.destroyedContainers.length ? `Destroyed containers: ${result.destroyedContainers.join(", ")}` : "No containers to destroy.",
    ...result.errors.map((item) => `Error: ${item}`),
  ].join("\n");
}

function formatDeleteResult(result: { sessionId: string; deleted: boolean; killedBeforeDelete: boolean; workflowTerminated: boolean; destroyedContainers: string[]; errors: string[] }): string {
  return [
    `Session ${result.sessionId.slice(0, 8)} ${result.deleted ? "deleted" : "was not deleted"}.`,
    result.killedBeforeDelete ? "Cleanup ran before delete." : "Session was already closed.",
    result.workflowTerminated ? "Workflow terminated." : "Workflow was not running.",
    result.destroyedContainers.length ? `Destroyed containers: ${result.destroyedContainers.join(", ")}` : "No containers to destroy.",
    ...result.errors.map((item) => `Error: ${item}`),
  ].join("\n");
}

function formatDeleteAllResult(result: { deleted: number; total: number; errors: string[] }): string {
  return [
    `Deleted ${result.deleted} of ${result.total} sessions.`,
    ...result.errors.map((item) => `Error: ${item}`),
  ].join("\n");
}

const helpText = `Commands:
/new - Start a new chat context
/fork - Fork the current context
/sessions [status] - Show recent sessions
/open [session-id] - Open an existing session
/kill [session-id|all] - Terminate session workflows and containers
/delete [session-id|all] - Delete sessions after cleanup
/name <name> - Name the current session
/rename <name> - Rename the current session
/models - Show models
/clear - Clear chat history
/help - Show this help message`;

export { App };

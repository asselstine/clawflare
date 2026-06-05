import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
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
  Model,
  ProviderInfo,
  ProviderModelInfo,
  SessionListResponse,
  SessionResponse,
  SessionSummary,
  WorkspaceProvider,
} from "@clawflare/types";
import { z } from "zod";
import { ClawflareApiClient } from "./lib/api";
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

interface TerminalEntry {
  id: string;
  command: string;
  cwd: string;
  output: string;
  details?: ContainerBashDetails;
  isError?: boolean;
}

const settingsSectionIds: SettingsSection[] = ["providers", "egress", "models", "account", "data"];

function sessionIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
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
  modelName: z.string().optional(),
  setAsDefault: z.boolean(),
  secrets: z.record(z.string()),
}).refine((value) => !value.setAsDefault || Boolean(value.modelName), {
  message: "modelName is required when choosing a default model",
  path: ["modelName"],
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
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [quickFileSelectedIndex, setQuickFileSelectedIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [showModelForm, setShowModelForm] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [setCreatedModelAsDefault, setSetCreatedModelAsDefault] = useState(false);
  const [modelSecrets, setModelSecrets] = useState<Record<string, string>>({});
  const [selectedEgress, setSelectedEgress] = useState("");
  const [showEgressForm, setShowEgressForm] = useState(false);
  const [egressSecrets, setEgressSecrets] = useState<Record<string, string>>({});
  const [egressConfig, setEgressConfig] = useState<Record<string, string>>({});
  const [egressEnabled, setEgressEnabled] = useState(true);
  const [composerRows, setComposerRows] = useState(2);
  const abortController = useRef<AbortController | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalInputRef = useRef<HTMLInputElement | null>(null);
  const messageScrollerRef = useRef<HTMLElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
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

  const info = useQuery({
    queryKey: ["info", settings.serverUrl, settings.token],
    queryFn: () => client.getInfo(),
    enabled: isConfigured,
  });

  const sessions = useQuery({
    queryKey: ["sessions", settings.serverUrl, settings.token],
    queryFn: () => client.listSessions({ status: "all", limit: 80 }),
    enabled: isConfigured,
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
    enabled: isConfigured && Boolean(selectedContainer),
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
    enabled: isConfigured && Boolean(selectedContainer && selectedFilePath),
  });

  const quickFileMode = selectedContainer !== null && terminalCommand.startsWith("/");
  const quickFileQuery = quickFileMode ? terminalCommand.slice(1).trim() : "";
  const quickFiles = useQuery({
    queryKey: ["container-find-paths", settings.serverUrl, settings.token, selectedContainer?.sessionId, selectedContainer?.containerId],
    queryFn: async (): Promise<ContainerFindResult[]> => {
      if (!selectedContainer) throw new Error("No container selected");
      const response = await client.invokeTool<ContainerFindDetails>(selectedContainer.sessionId, "container_find", {
        containerId: selectedContainer.containerId,
        path: ".",
        type: "any",
        maxResults: 1000,
      });
      return response.result.details?.results ?? [];
    },
    enabled: isConfigured && Boolean(selectedContainer) && quickFileMode,
  });
  const quickFileMatches = useMemo(
    () => filterQuickFiles(quickFiles.data ?? [], quickFileQuery),
    [quickFiles.data, quickFileQuery],
  );

  const providers = useQuery({
    queryKey: ["providers", settings.serverUrl, settings.token],
    queryFn: () => client.listProviders(),
    enabled: isConfigured && appPage === "settings",
  });

  const workspaceProviders = useQuery({
    queryKey: ["workspace-providers", settings.serverUrl, settings.token],
    queryFn: () => client.listConfiguredProviders(),
    enabled: isConfigured && appPage === "settings",
  });

  const providerModels = useQuery({
    queryKey: ["provider-models", settings.serverUrl, settings.token, selectedProvider],
    queryFn: () => client.listProviderModels(selectedProvider),
    enabled: isConfigured && appPage === "settings" && Boolean(selectedProvider),
  });

  const models = useQuery({
    queryKey: ["models", settings.serverUrl, settings.token],
    queryFn: () => client.listModels(),
    enabled: isConfigured && appPage === "settings",
  });

  const availableEgress = useQuery({
    queryKey: ["available-egress", settings.serverUrl, settings.token],
    queryFn: () => client.listAvailableEgressHandlers(),
    enabled: isConfigured && appPage === "settings",
  });

  const configuredEgress = useQuery({
    queryKey: ["egress", settings.serverUrl, settings.token],
    queryFn: () => client.listEgressHandlers({ enabledOnly: false }),
    enabled: isConfigured && appPage === "settings",
  });

  const renameSession = useMutation({
    mutationFn: (name: string) => client.renameSession(sessionId, name),
    onSuccess: () => {
      setStatusText("Session renamed");
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
        modelName: selectedModel || undefined,
        setAsDefault: setCreatedModelAsDefault,
        secrets: pruneEmpty(modelSecrets),
      });
      if (!parsed.setAsDefault) {
        return client.createProvider({
          provider: parsed.provider,
          secrets: parsed.secrets,
        });
      }
      return client.createModel({
        provider: parsed.provider,
        modelName: parsed.modelName!,
        secrets: parsed.secrets,
        setAsDefault: true,
      });
    },
    onSuccess: () => {
      setModelSecrets({});
      setSetCreatedModelAsDefault(false);
      setShowModelForm(false);
      setStatusText("Provider configured");
      void queryClient.invalidateQueries({ queryKey: ["workspace-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      void info.refetch();
    },
    onError: showError,
  });

  const deleteModel = useMutation({
    mutationFn: (id: string) => client.deleteModel(id),
    onSuccess: () => {
      setStatusText("Model removed");
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      void info.refetch();
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

  const currentSession = sessions.data?.sessions.find((session) => session.id === sessionId);
  const activeSessionIsProcessing = currentSession?.status === "processing" || serverProcessingSessionId === sessionId;
  const composerBusy = isRunning || activeSessionIsProcessing;

  useEffect(() => {
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
      messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, composerBusy]);

  useEffect(() => {
    if (!isConfigured) return;
    const pathSessionId = sessionIdFromLocation();
    if (!pathSessionId || pathSessionId === sessionId || initialPathSessionRef.current === pathSessionId) return;
    initialPathSessionRef.current = pathSessionId;
    void openSession(pathSessionId, { history: "replace" });
  }, [isConfigured, settings.serverUrl, settings.token]);

  useEffect(() => {
    const onPopState = (): void => {
      const pathSettingsSection = settingsSectionFromLocation();
      if (pathSettingsSection) {
        setAppPage("settings");
        setSettingsSection(pathSettingsSection);
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
  }, [currentSession, serverProcessingSessionId]);

  useEffect(() => {
    if (selectedContainer && appPage === "chat") {
      focusTerminalPrompt();
    }
  }, [appPage, selectedContainer?.containerId]);

  useEffect(() => {
    if (!selectedContainer || appPage !== "chat") return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntryElement(document.activeElement)) return;

      event.preventDefault();
      setTerminalCommand("/");
      setSelectedFilePath(null);
      focusTerminalPrompt();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appPage, selectedContainer]);

  useEffect(() => {
    setQuickFileSelectedIndex(0);
  }, [quickFileQuery, selectedContainer?.containerId]);

  useEffect(() => {
    if (quickFileSelectedIndex >= quickFileMatches.length) {
      setQuickFileSelectedIndex(Math.max(0, quickFileMatches.length - 1));
    }
  }, [quickFileMatches.length, quickFileSelectedIndex]);

  useEffect(() => {
    const cause = containerListing.error ?? selectedFile.error;
    if (cause) showError(cause);
  }, [containerListing.error, selectedFile.error]);

  useEffect(() => {
    if (!isConfigured || !sessionId || appPage !== "chat" || isRunning || !activeSessionIsProcessing) return;
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
  }, [activeSessionIsProcessing, appPage, isConfigured, isRunning, sessionId, settings.serverUrl, settings.token]);

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

  function focusPrompt(): void {
    window.requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });
  }

  function focusTerminalPrompt(): void {
    window.requestAnimationFrame(() => {
      terminalInputRef.current?.focus();
    });
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
    focusPrompt();
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

  function openContainerWorkspace(next: SelectedContainer): void {
    setSelectedContainer(next);
    setContainerPath(".");
    setSelectedFilePath(null);
    setMobileSessionsOpen(false);
    setStatusText(`Viewing ${next.containerId.slice(0, 12)}`);
    focusTerminalPrompt();
  }

  function openContainerDirectory(path: string): void {
    setContainerPath(path || ".");
    setSelectedFilePath(null);
  }

  function closeContainerWorkspace(): void {
    setSelectedContainer(null);
    setContainerPath(".");
    setSelectedFilePath(null);
    setTerminalCommand("");
    setTerminalEntries([]);
  }

  async function submitTerminalCommand(): Promise<void> {
    const command = terminalCommand.trim();
    if (quickFileMode) {
      openQuickFile();
      return;
    }
    if (!selectedContainer || !command || terminalRunning) return;

    const cwd = containerPath === "." ? "." : containerPath;
    setTerminalCommand("");
    setTerminalRunning(true);
    setStatusText(`Running ${command}`);

    try {
      const response = await client.invokeTool<ContainerBashDetails>(selectedContainer.sessionId, "container_bash", {
        containerId: selectedContainer.containerId,
        command,
        cwd,
        maxOutputChars: 120_000,
      });
      const output = response.result.content?.find((part) => part.type === "text")?.text ?? "";
      setTerminalEntries((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          command,
          cwd,
          output,
          details: response.result.details,
          isError: response.result.details?.ok === false || Boolean(response.result.details?.exitCode),
        },
      ]);
      setStatusText("Command complete");
      void containerListing.refetch();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTerminalEntries((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          command,
          cwd,
          output: message,
          isError: true,
        },
      ]);
      showError(cause);
    } finally {
      setTerminalRunning(false);
    }
  }

  function openQuickFile(path?: string): void {
    const selectedMatch = path
      ? quickFileMatches.find((match) => match.path === path)
      : quickFileMatches[quickFileSelectedIndex];
    const selectedPath = path ?? selectedMatch?.path ?? quickFileQuery;
    const normalizedPath = normalizeQuickFilePath(selectedPath);
    if (!normalizedPath) return;
    if (selectedMatch?.type === "directory" || selectedPath.endsWith("/")) {
      openContainerDirectory(normalizedPath);
    } else {
      setSelectedFilePath(normalizedPath);
    }
    setTerminalCommand("");
    setStatusText(`${selectedMatch?.type === "directory" ? "Opened directory" : "Opened"} ${normalizedPath}`);
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
      setStatusText(finalSession.status === "error" ? "Error" : "Complete");
      setError(finalSession.status === "error" ? finalSession.errorMessage ?? "Session failed" : null);
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
        if (args) renameSession.mutate(args);
        else showError(new Error("Usage: /name <session-name>"));
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
    const content = prompt.trim();
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
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatusText("Aborted");
        setMessages((current) => [...current, { role: "assistant", content: "Operation aborted." }]);
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
    openSettings("account", { history: "replace" });
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
  const connected = isConfigured && !info.isError;

  return (
    <div className="flex h-dvh min-h-0 bg-shell-950 text-slate-100">
      <aside className={`hidden shrink-0 border-r border-shell-700 bg-shell-900/95 transition-[width] md:flex md:flex-col ${sessionsCollapsed ? "w-14" : "w-72"}`}>
        <SessionSidebar
          currentSessionId={sessionId}
          sessions={sessions.data?.sessions ?? []}
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
            serverInfo={info.data}
            providers={providers.data ?? []}
            workspaceProviders={workspaceProviders.data ?? []}
            providerModels={providerModels.data ?? []}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            showModelForm={showModelForm}
            selectedProviderInfo={selectedProviderInfo}
            models={models.data?.models ?? []}
            defaultModelId={models.data?.defaultModelId}
            setCreatedModelAsDefault={setCreatedModelAsDefault}
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
            onSetCreatedModelAsDefaultChange={setSetCreatedModelAsDefault}
            onModelSecretChange={(key, value) => setModelSecrets((current) => ({ ...current, [key]: value }))}
            onCreateModel={() => addProvider.mutate()}
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
                path={containerPath}
                listing={containerListing.data}
                listingLoading={containerListing.isFetching}
                filePath={selectedFilePath}
                file={selectedFile.data}
                fileLoading={selectedFile.isFetching}
                terminalEntries={terminalEntries}
                terminalRunning={terminalRunning}
                error={error}
                onDismissError={() => setError(null)}
                onClose={closeContainerWorkspace}
                onOpenDirectory={openContainerDirectory}
                onOpenFile={setSelectedFilePath}
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
                  ) : messages.length === 0 ? (
                    <EmptyState
                      icon={<MessageSquare className="h-7 w-7" />}
                      title="Ready for a new turn"
                      body="Ask the agent to inspect sessions, write code, use containers, or configure integrations."
                    />
                  ) : (
                    <>
                      <PromptHistoryReveal promptHistory={promptHistory} visibleMessages={messages} />
                      {messages.map((message, index) => <ChatMessage key={`${index}-${message.role}`} message={message} />)}
                    </>
                  )}
                  {composerBusy ? <Thinking /> : null}
                  {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
                  <div ref={messageEndRef} />
                </div>
              </section>
            )}

            <footer className="border-t border-shell-700 bg-shell-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="mx-auto max-w-4xl">
                {selectedContainer ? (
                  <div className="relative flex items-center gap-2 rounded-lg border border-shell-600 bg-shell-850 p-2 shadow-panel">
                    {quickFileMode ? (
                      <QuickFilePopup
                        query={quickFileQuery}
                        matches={quickFileMatches}
                        selectedIndex={quickFileSelectedIndex}
                        loading={quickFiles.isFetching}
                        onSelect={(path) => openQuickFile(path)}
                      />
                    ) : null}
                    <div className="hidden shrink-0 items-center gap-2 rounded-md bg-shell-900 px-2 py-2 font-mono text-xs text-slate-500 sm:flex">
                      <Terminal className="h-4 w-4 text-accent-500" />
                      /workspace/{containerPath === "." ? "" : containerPath}
                    </div>
                    <input
                      ref={terminalInputRef}
                      className="h-10 min-w-0 flex-1 border-0 bg-transparent px-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500"
                      value={terminalCommand}
                      placeholder={terminalRunning ? "Command running..." : "Run command in container"}
                      disabled={terminalRunning}
                      onChange={(event) => setTerminalCommand(event.target.value)}
                      onKeyDown={(event) => {
                        if (quickFileMode && event.key === "ArrowDown") {
                          event.preventDefault();
                          setQuickFileSelectedIndex((current) => Math.min(current + 1, Math.max(0, quickFileMatches.length - 1)));
                          return;
                        }
                        if (quickFileMode && event.key === "ArrowUp") {
                          event.preventDefault();
                          setQuickFileSelectedIndex((current) => Math.max(0, current - 1));
                          return;
                        }
                        if (quickFileMode && event.key === "Escape") {
                          event.preventDefault();
                          setTerminalCommand("");
                          return;
                        }
                        if (quickFileMode && event.key === "Tab") {
                          event.preventDefault();
                          const selectedMatch = quickFileMatches[quickFileSelectedIndex];
                          if (selectedMatch) {
                            setTerminalCommand(`/${selectedMatch.path}${selectedMatch.type === "directory" ? "/" : ""}`);
                          }
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitTerminalCommand();
                        }
                      }}
                    />
                    <button
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white transition hover:bg-accent-500 disabled:bg-shell-700"
                      disabled={!terminalCommand.trim() || terminalRunning}
                      title={quickFileMode ? "Open file" : "Run"}
                      onClick={() => void submitTerminalCommand()}
                    >
                      {terminalRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-end gap-2 rounded-lg border border-shell-600 bg-shell-850 p-2 shadow-panel">
                  <textarea
                    ref={promptInputRef}
                    className="scrollbar min-h-11 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
                    rows={composerRows}
                    value={prompt}
                    placeholder={composerBusy ? "Agent is running..." : "Message Clawflare or type /help"}
                    disabled={!isConfigured}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      setComposerRows(Math.min(8, Math.max(2, event.target.value.split("\n").length)));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submitPrompt();
                      }
                    }}
                  />
                  {composerBusy ? (
                    <IconButton title="Abort" onClick={abortRun}>
                      <Square className="h-4 w-4" />
                    </IconButton>
                  ) : (
                    <button
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white transition hover:bg-accent-500 disabled:bg-shell-700"
                      disabled={!prompt.trim() || !isConfigured || composerBusy}
                      title="Send"
                      onClick={() => void submitPrompt()}
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                  </div>
                )}
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

interface SessionSidebarProps {
  currentSessionId: string;
  sessions: SessionSummary[];
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
          const containerIds = sessionContainers(session);
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
                  {containerIds.map((containerId) => (
                    <button
                      key={containerId}
                      className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-shell-800 ${
                        props.selectedContainer?.containerId === containerId ? "bg-accent-600/15 text-accent-300" : "text-slate-500"
                      }`}
                      title={containerId}
                      onClick={() => props.onOpenContainer({ sessionId: session.id, containerId })}
                    >
                      <FileText className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mb-1 flex flex-col gap-0.5">
                  {containerIds.map((containerId) => (
                    <button
                      key={containerId}
                      className={`flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition hover:bg-shell-850 ${
                        props.selectedContainer?.containerId === containerId ? "bg-accent-600/15 text-accent-200" : "text-slate-400"
                      }`}
                      title={containerId}
                      onClick={() => props.onOpenContainer({ sessionId: session.id, containerId })}
                    >
                      <Folder className="h-4 w-4 shrink-0" />
                      <span className="truncate">{containerId}</span>
                    </button>
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

function ContainerWorkspaceView(props: {
  selectedContainer: SelectedContainer;
  path: string;
  listing?: ContainerLsDetails;
  listingLoading: boolean;
  filePath: string | null;
  file?: ContainerFile;
  fileLoading: boolean;
  terminalEntries: TerminalEntry[];
  terminalRunning: boolean;
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
              <span className="truncate">{props.selectedContainer.containerId}</span>
            </div>
            <h2 className="truncate font-mono text-sm font-semibold text-slate-100">/workspace/{props.path === "." ? "" : props.path}</h2>
          </div>
          <div className="flex items-center gap-2">
            {props.terminalRunning ? (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Running
              </div>
            ) : null}
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
            {props.terminalEntries.length ? <TerminalOutput entries={props.terminalEntries} /> : null}
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

function TerminalOutput({ entries }: { entries: TerminalEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Terminal className="h-7 w-7" />}
        title="Container terminal"
        body="Run commands from the terminal below. Select a file in the sidebar to view it here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <section key={entry.id} className="rounded-md border border-shell-700 bg-shell-900">
          <div className="border-b border-shell-700 px-3 py-2 font-mono text-xs text-slate-500">
            <span className="text-accent-300">$</span> <span className="text-slate-300">{entry.command}</span>
            <span className="ml-2">/workspace/{entry.cwd === "." ? "" : entry.cwd}</span>
          </div>
          <pre className={`scrollbar max-h-96 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5 ${entry.isError ? "text-red-200" : "text-slate-300"}`}>
            {entry.output || "Command executed successfully."}
          </pre>
        </section>
      ))}
    </div>
  );
}

function QuickFilePopup(props: {
  query: string;
  matches: ContainerFindResult[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (path: string) => void;
}): JSX.Element {
  return (
    <div className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-md border border-shell-600 bg-shell-900 shadow-panel">
      <div className="flex items-center justify-between border-b border-shell-700 px-3 py-2 text-xs text-slate-500">
        <span>Quick open</span>
        {props.loading ? (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching
          </span>
        ) : (
          <span>{props.matches.length} match{props.matches.length === 1 ? "" : "es"}</span>
        )}
      </div>
      <div className="scrollbar max-h-72 overflow-y-auto p-1">
        {props.matches.map((match, index) => (
          <button
            key={match.path}
            className={`flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition ${
              index === props.selectedIndex ? "bg-accent-600/15 text-accent-200" : "text-slate-300 hover:bg-shell-850"
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              props.onSelect(match.path);
            }}
          >
            {match.type === "directory" ? <Folder className="h-4 w-4 shrink-0 text-accent-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-500" />}
            <span className="truncate font-mono">{match.path}</span>
            <span className="ml-auto shrink-0 text-xs text-slate-600">{match.type === "directory" ? "dir" : formatBytes(match.size)}</span>
          </button>
        ))}
        {!props.loading && props.matches.length === 0 ? (
          <div className="px-3 py-6 text-sm text-slate-500">
            {props.query ? `Press Enter to try opening "${props.query}".` : "No files found."}
          </div>
        ) : null}
      </div>
    </div>
  );
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

function inferContainerIds(sessionId: string, displayMessages: DisplayMessage[]): string[] {
  const containers = new Set<string>();
  for (const message of displayMessages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (!toolCall.name.startsWith("container_")) continue;
      const explicitId = stringValue(toolCall.params.containerId);
      const detailsId = detailsContainerId(toolCall.result?.details);
      containers.add(explicitId ?? detailsId ?? defaultContainerId(sessionId));
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

function defaultContainerId(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}`;
}

function sessionContainers(session: SessionSummary): string[] {
  return mergeContainers([defaultContainerId(session.id)], session.containers ?? []);
}

function mergeContainers(current: string[], next: string[]): string[] {
  return [...new Set([...current, ...next])];
}

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || element.getAttribute("contenteditable") === "true";
}

function filterQuickFiles(files: ContainerFindResult[], query: string): ContainerFindResult[] {
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

function ChatMessage({ message }: { message: DisplayMessage }): JSX.Element {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const isSystem = message.role === "system";
  if (isSystem) return <PromptHistoryBlock label="System" content={message.content} />;

  if (isError) {
    return (
      <article className="flex justify-start gap-3">
        <Avatar role={message.role} />
        <div className="min-w-0 max-w-[84%] rounded-lg bg-red-950/55 px-4 py-3 text-red-100 ring-1 ring-red-800">
          {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} className="markdown text-sm">{message.content}</ReactMarkdown> : null}
        </div>
      </article>
    );
  }

  if (!isUser && !isError) {
    return (
      <article className="w-full min-w-0 py-1">
        {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} className="markdown text-[0.95rem] text-slate-100">{message.content}</ReactMarkdown> : null}
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

interface SettingsPageProps {
  section: SettingsSection;
  settingsError: string | null;
  loginStatus: LoginStatus;
  loginMessage: string;
  loginUser: string | null;
  serverInfo?: { contextWindow: number; supportsWorkspaceModels: boolean; supportedProviders: string[]; workspace?: { hasModels: boolean } };
  providers: ProviderInfo[];
  workspaceProviders: WorkspaceProvider[];
  providerModels: ProviderModelInfo[];
  selectedProvider: string;
  selectedModel: string;
  showModelForm: boolean;
  selectedProviderInfo?: ProviderInfo;
  models: Model[];
  defaultModelId?: string;
  setCreatedModelAsDefault: boolean;
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
  onSetCreatedModelAsDefaultChange: (value: boolean) => void;
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

  return (
    <PanelStack>
      <SectionTitle icon={<Database className="h-4 w-4" />} title="Default model" />
      {!hasModels ? (
        <InfoBox>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-200">No models configured</p>
              <p className="mt-1 text-sm text-slate-500">Configure a provider before choosing a default model.</p>
            </div>
            <button className="secondary-btn self-start" onClick={() => props.onSectionChange("providers")}>
              <KeyRound className="h-4 w-4" />
              Configure providers
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
          <label className="flex items-start gap-3 rounded-md border border-shell-700 bg-shell-900 px-3 py-2 text-sm text-slate-300">
            <input
              className="mt-1"
              type="checkbox"
              checked={props.setCreatedModelAsDefault}
              onChange={(event) => props.onSetCreatedModelAsDefaultChange(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block font-medium text-slate-200">Choose Default Model</span>
              <span className="block text-xs text-slate-500">Use this model automatically for new chats unless another model is selected.</span>
            </span>
          </label>
          {props.setCreatedModelAsDefault ? (
            <Field label="Default model">
              <select className="input" value={props.selectedModel} onChange={(event) => props.onModelChange(event.target.value)}>
                {props.providerModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.name} ({model.id})</option>
                ))}
              </select>
            </Field>
          ) : null}
          <button className="primary-btn self-start" disabled={!props.selectedProvider || (props.setCreatedModelAsDefault && !props.selectedModel)} onClick={props.onCreateModel}>
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

function EmptyState({ icon, title, body }: { icon: JSX.Element; title: string; body: string }): JSX.Element {
  return (
    <div className="mx-auto mt-16 max-w-md text-center sm:mt-24">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-shell-850 text-accent-500 ring-1 ring-shell-700">{icon}</div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
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
/models - Show models
/clear - Clear chat history
/help - Show this help message`;

export { App };

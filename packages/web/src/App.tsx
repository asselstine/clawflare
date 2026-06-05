import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Circle,
  Database,
  Hammer,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Plus,
  Power,
  Send,
  Settings,
  Shield,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import type {
  EgressHandlerInfo,
  ModelConnection,
  ProviderInfo,
  ProviderModelInfo,
  SessionStatus,
  SessionSummary,
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
  formatUpdatedAt,
  getEventDisplayMessage,
  type DisplayMessage,
  type ToolCallInfo,
} from "./lib/format";
import { loadSettings, saveSettings, type AppSettings } from "./lib/settings";

type AppPage = "chat" | "settings";
type SettingsSection = "egress" | "models" | "account" | "data";
type LoginStatus = "idle" | "starting" | "waiting" | "approved" | "error";

const settingsSectionIds: SettingsSection[] = ["egress", "models", "account", "data"];

function sessionIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function settingsSectionFromLocation(): SettingsSection | null {
  const match = window.location.pathname.match(/^\/settings(?:\/([^/]+))?$/);
  if (!match) return null;
  const section = match[1];
  if (!section) return "egress";
  return settingsSectionIds.includes(section as SettingsSection) ? (section as SettingsSection) : "egress";
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

const modelFormSchema = z.object({
  provider: z.string().min(1),
  modelName: z.string().min(1),
  displayName: z.string().optional(),
  setAsDefault: z.boolean(),
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
  const [prompt, setPrompt] = useState("");
  const [statusText, setStatusText] = useState("Disconnected");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appPage, setAppPage] = useState<AppPage>(initialSettingsSection ? "settings" : "chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSettingsSection ?? "egress");
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [showModelForm, setShowModelForm] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelDisplayName, setModelDisplayName] = useState("");
  const [modelSecrets, setModelSecrets] = useState<Record<string, string>>({});
  const [selectedEgress, setSelectedEgress] = useState("");
  const [showEgressForm, setShowEgressForm] = useState(false);
  const [egressSecrets, setEgressSecrets] = useState<Record<string, string>>({});
  const [egressConfig, setEgressConfig] = useState<Record<string, string>>({});
  const [egressEnabled, setEgressEnabled] = useState(true);
  const [composerRows, setComposerRows] = useState(2);
  const abortController = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
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
    refetchInterval: isRunning ? 2000 : 15_000,
  });

  const providers = useQuery({
    queryKey: ["providers", settings.serverUrl, settings.token],
    queryFn: () => client.listProviders(),
    enabled: isConfigured && appPage === "settings",
  });

  const providerModels = useQuery({
    queryKey: ["provider-models", settings.serverUrl, settings.token, selectedProvider],
    queryFn: () => client.listProviderModels(selectedProvider),
    enabled: isConfigured && appPage === "settings" && Boolean(selectedProvider),
  });

  const modelConnections = useQuery({
    queryKey: ["model-connections", settings.serverUrl, settings.token],
    queryFn: () => client.listModelConnections(),
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

  const addModelConnection = useMutation({
    mutationFn: () => {
      const parsed = modelFormSchema.parse({
        provider: selectedProvider,
        modelName: selectedModel,
        displayName: modelDisplayName.trim() || undefined,
        setAsDefault: true,
        secrets: pruneEmpty(modelSecrets),
      });
      return client.createModelConnection(parsed);
    },
    onSuccess: () => {
      setModelSecrets({});
      setModelDisplayName("");
      setShowModelForm(false);
      setStatusText("Model connection added");
      void queryClient.invalidateQueries({ queryKey: ["model-connections"] });
      void info.refetch();
    },
    onError: showError,
  });

  const deleteModelConnection = useMutation({
    mutationFn: (id: string) => client.deleteModelConnection(id),
    onSuccess: () => {
      setStatusText("Model connection removed");
      void queryClient.invalidateQueries({ queryKey: ["model-connections"] });
      void info.refetch();
    },
    onError: showError,
  });

  const setDefaultModel = useMutation({
    mutationFn: (id: string | null) => client.setDefaultModelConnection(id),
    onSuccess: () => {
      setStatusText("Default model updated");
      void queryClient.invalidateQueries({ queryKey: ["model-connections"] });
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

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isRunning]);

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

  function showError(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    setStatusText("Error");
  }

  function startDraftSession(options: { history?: "push" | "replace" | false } = {}): void {
    abortRun();
    setAppPage("chat");
    setMobileSessionsOpen(false);
    setSessionId("");
    setMessages([]);
    setError(null);
    setStatusText("Ready for first prompt");
    if (options.history !== false) updateBrowserRootPath(options.history ?? "push");
  }

  function openSettings(section: SettingsSection | null = null, options: { history?: "push" | "replace" | false } = {}): void {
    setAppPage("settings");
    setMobileSessionsOpen(false);
    setSettingsSection(section ?? "egress");
    if (options.history !== false) updateBrowserSettingsPath(section, options.history ?? "push");
  }

  function openSettingsSection(section: SettingsSection): void {
    setSettingsSection(section);
    setAppPage("settings");
    updateBrowserSettingsPath(section);
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
          setMessages([]);
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
      });
      const recentMessages = formatMessagesFromEvents(session.events);
      setAppPage("chat");
      setMobileSessionsOpen(false);
      setSessionId(session.id);
      if (options.history !== false) updateBrowserSessionPath(session.id, options.history ?? "push");
      setMessages(attachToolResults(recentMessages));
      setError(session.status === "error" ? session.errorMessage ?? null : null);
      setStatusText(`Opened recent ${session.id.slice(0, 8)}`);
    } catch (cause) {
      showError(cause);
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
    if (!content || isRunning) return;
    setPrompt("");
    setComposerRows(2);

    if (handleCommand(content)) return;
    const optimistic: DisplayMessage = { role: "user", content };
    const currentSessionId = sessionId;

    setMessages((current) => [...current, optimistic]);
    setIsRunning(true);
    setError(null);
    setStatusText("Submitting");
    const controller = new AbortController();
    abortController.current = controller;

    try {
      const submitted = await client.submitChat({
        content,
        sessionId: currentSessionId || undefined,
      });
      setSessionId(submitted.sessionId);
      updateBrowserSessionPath(submitted.sessionId, currentSessionId ? "replace" : "push");
      setStatusText(`Processing ${submitted.sessionId.slice(0, 8)}`);

      for await (const update of client.streamSession(submitted.sessionId, submitted.eventCursor, controller.signal)) {
        const lastEvent = [...update.newEvents].reverse().map(getEventDisplayMessage).find(Boolean);
        if (lastEvent) setStatusText(lastEvent);

        setMessages(() => {
          const serverMessages = attachToolResults((update.session.messages ?? []).map(formatMessageForDisplay));
          const reconciled = serverMessages.some((message) => message.role === "user" && message.content.trim() === content);
          const base = reconciled ? serverMessages : [...serverMessages, optimistic];
          return attachToolResults(applyAssistantPartialEvents(base, update.newEvents));
        });

        if (update.complete) {
          if (update.session.status === "error") {
            throw new Error(update.session.errorMessage ?? "Session failed");
          }
          break;
        }
      }

      setStatusText("Complete");
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatusText("Aborted");
        setMessages((current) => [...current, { role: "assistant", content: "Operation aborted." }]);
      } else {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setMessages((current) => [...current, { role: "error", content: message }]);
        setStatusText("Error");
      }
    } finally {
      setIsRunning(false);
      abortController.current = null;
    }
  }

  function abortRun(): void {
    abortController.current?.abort();
    abortController.current = null;
    setIsRunning(false);
  }

  function signOut(): void {
    const nextSettings = { ...settings, token: "" };
    saveSettings(nextSettings);
    setSettings(nextSettings);
    setSessionId("");
    setMessages([]);
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
  const currentSession = sessions.data?.sessions.find((session) => session.id === sessionId);
  const connected = isConfigured && !info.isError;

  return (
    <div className="flex h-dvh min-h-0 bg-shell-950 text-slate-100">
      <aside className="hidden w-72 shrink-0 border-r border-shell-700 bg-shell-900/95 md:flex md:flex-col">
        <SessionSidebar
          currentSessionId={sessionId}
          sessions={sessions.data?.sessions ?? []}
          onNew={startDraftSession}
          onOpen={(id) => void openSession(id)}
          onDelete={(id) => deleteSession.mutate(id)}
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
              onNew={startDraftSession}
              onOpen={(id) => void openSession(id)}
              onDelete={(id) => deleteSession.mutate(id)}
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
            providerModels={providerModels.data ?? []}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            showModelForm={showModelForm}
            selectedProviderInfo={selectedProviderInfo}
            modelConnections={modelConnections.data?.modelConnections ?? []}
            defaultModelConnectionId={modelConnections.data?.defaultModelConnectionId}
            modelDisplayName={modelDisplayName}
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
            onModelDisplayNameChange={setModelDisplayName}
            onModelSecretChange={(key, value) => setModelSecrets((current) => ({ ...current, [key]: value }))}
            onCreateModel={() => addModelConnection.mutate()}
            onDeleteModel={(id) => deleteModelConnection.mutate(id)}
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
            <section className="scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-4 sm:py-6">
              <div className="mx-auto flex max-w-4xl flex-col gap-5">
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
                  messages.map((message, index) => <ChatMessage key={`${index}-${message.role}`} message={message} />)
                )}
                {isRunning ? <Thinking /> : null}
                {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
                <div ref={messageEndRef} />
              </div>
            </section>

            <footer className="border-t border-shell-700 bg-shell-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="mx-auto max-w-4xl">
                <div className="flex items-end gap-2 rounded-lg border border-shell-600 bg-shell-850 p-2 shadow-panel">
                  <textarea
                    className="scrollbar min-h-11 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
                    rows={composerRows}
                    value={prompt}
                    placeholder={isRunning ? "Agent is running..." : "Message Clawflare or type /help"}
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
                  {isRunning ? (
                    <IconButton title="Abort" onClick={abortRun}>
                      <Square className="h-4 w-4" />
                    </IconButton>
                  ) : (
                    <button
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white transition hover:bg-accent-500 disabled:bg-shell-700"
                      disabled={!prompt.trim() || !isConfigured}
                      title="Send"
                      onClick={() => void submitPrompt()}
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </div>
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
  onNew: () => void;
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onSettings: () => void;
  settingsActive: boolean;
}

function SessionSidebar(props: SessionSidebarProps): JSX.Element {
  return (
    <>
      <div className="flex h-16 items-center justify-between border-b border-shell-700 px-3">
        <button className="flex h-10 items-center gap-2 rounded-md bg-slate-100 px-3 text-sm font-medium text-shell-950 transition hover:bg-white" onClick={props.onNew}>
          <Plus className="h-4 w-4" />
          New chat
        </button>
      </div>
      <div className="scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {props.sessions.map((session) => (
          <div
            key={session.id}
            className={`mb-1 flex w-full items-start gap-1 rounded-md p-2 transition hover:bg-shell-800 ${
              session.id === props.currentSessionId ? "bg-shell-800 ring-1 ring-accent-600/60" : ""
            }`}
          >
            <button className="min-w-0 flex-1 p-1 text-left" onClick={() => props.onOpen(session.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-100">{formatSessionTitle(session)}</span>
                <SessionStatusDot status={session.status} />
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span>{session.messageCount} events</span>
                <span>{formatUpdatedAt(session.updatedAt)}</span>
              </div>
              {session.modelProvider && session.modelName ? (
                <div className="mt-1 truncate text-xs text-slate-400">
                  {session.modelProvider}/{session.modelName}
                </div>
              ) : null}
            </button>
            <button
              className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-red-950/50 hover:text-red-200"
              title="Delete session"
              onClick={() => props.onDelete(session.id)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        {props.sessions.length === 0 ? <p className="px-2 py-6 text-sm text-slate-500">No sessions found.</p> : null}
      </div>
      <div className="border-t border-shell-700 p-3">
        <button
          className={`flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 text-sm transition ${
            props.settingsActive
              ? "border-accent-600 bg-accent-600/20 text-accent-300"
              : "border-shell-700 bg-shell-850 text-slate-300 hover:bg-shell-800"
          }`}
          onClick={props.onSettings}
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      </div>
    </>
  );
}

function ChatMessage({ message }: { message: DisplayMessage }): JSX.Element {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  return (
    <article className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser ? <Avatar role={message.role} /> : null}
      <div className={`min-w-0 max-w-[84%] rounded-lg px-4 py-3 ${isUser ? "bg-slate-100 text-shell-950" : isError ? "bg-red-950/55 text-red-100 ring-1 ring-red-800" : "bg-shell-850 text-slate-100 ring-1 ring-shell-700"}`}>
        {message.content ? (
          isUser ? (
            <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
          ) : (
            <ReactMarkdown className="markdown text-sm">{message.content}</ReactMarkdown>
          )
        ) : null}
        {message.toolCalls?.length ? (
          <div className="mt-3 flex flex-col gap-2">
            {message.toolCalls.map((toolCall, index) => (
              <ToolCall key={`${toolCall.id}-${index}`} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
      </div>
      {isUser ? <Avatar role={message.role} /> : null}
    </article>
  );
}

function ToolCall({ toolCall }: { toolCall: ToolCallInfo }): JSX.Element {
  const hasError = toolCall.status === "error" || toolCall.result?.isError;
  const complete = toolCall.status === "complete" || Boolean(toolCall.result && !hasError);
  return (
    <details className={`rounded-md border px-3 py-2 ${hasError ? "border-red-700 bg-red-950/35" : complete ? "border-emerald-800 bg-emerald-950/20" : "border-shell-600 bg-shell-900"}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
        {hasError ? <X className="h-4 w-4 text-red-300" /> : complete ? <Check className="h-4 w-4 text-mint-500" /> : <Circle className="h-3 w-3 fill-accent-500 text-accent-500" />}
        <span className="truncate font-medium">{formatToolCallHeader(toolCall.name, toolCall.params)}</span>
        <ChevronDown className="ml-auto h-4 w-4 text-slate-500" />
      </summary>
      <pre className="scrollbar mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-shell-950 p-3 text-xs text-slate-300">
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
  serverInfo?: { contextWindow: number; supportsWorkspaceModelConnections: boolean; supportedProviders: string[]; workspace?: { hasModelConnections: boolean } };
  providers: ProviderInfo[];
  providerModels: ProviderModelInfo[];
  selectedProvider: string;
  selectedModel: string;
  showModelForm: boolean;
  selectedProviderInfo?: ProviderInfo;
  modelConnections: ModelConnection[];
  defaultModelConnectionId?: string;
  modelDisplayName: string;
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
  onModelDisplayNameChange: (value: string) => void;
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
  { id: "egress", label: "Egress", icon: <Shield className="h-4 w-4" /> },
  { id: "models", label: "Models", icon: <Database className="h-4 w-4" /> },
  { id: "account", label: "Account", icon: <User className="h-4 w-4" /> },
  { id: "data", label: "Data", icon: <Trash2 className="h-4 w-4" /> },
];

function SettingsPage(props: SettingsPageProps): JSX.Element {
  return (
    <section className="scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-4 sm:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-500">Manage account access, model connections, egress handlers, and workspace data.</p>
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
  return (
    <PanelStack>
      <SectionTitle icon={<Database className="h-4 w-4" />} title="Configured models" />
      {props.modelConnections.map((connection) => (
        <Row key={connection.id}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{connection.displayName || `${connection.provider}/${connection.modelName}`}</p>
            <p className="truncate text-xs text-slate-500">{connection.provider}/{connection.modelName}</p>
          </div>
          <IconButton title="Set default" active={connection.id === props.defaultModelConnectionId} onClick={() => props.onSetDefaultModel(connection.id)}>
            <Check className="h-4 w-4" />
          </IconButton>
          <IconButton title="Delete" onClick={() => props.onDeleteModel(connection.id)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </Row>
      ))}
      {props.modelConnections.length === 0 ? <p className="text-sm text-slate-500">No model connections configured.</p> : null}

      <button className="secondary-btn self-start" onClick={props.onToggleModelForm}>
        {props.showModelForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        Add Model
      </button>

      {props.showModelForm ? (
        <div className="flex flex-col gap-4 rounded-md border border-shell-700 bg-shell-850 p-4">
          <SectionTitle icon={<Plus className="h-4 w-4" />} title="Add model" />
          <Field label="Provider">
            <select className="input" value={props.selectedProvider} onChange={(event) => props.onProviderChange(event.target.value)}>
              {props.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select className="input" value={props.selectedModel} onChange={(event) => props.onModelChange(event.target.value)}>
              {props.providerModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name} ({model.id})</option>
              ))}
            </select>
          </Field>
          <Field label="Display name">
            <input className="input" value={props.modelDisplayName} onChange={(event) => props.onModelDisplayNameChange(event.target.value)} placeholder="optional" />
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
          <button className="primary-btn self-start" disabled={!props.selectedProvider || !props.selectedModel} onClick={props.onCreateModel}>
            <Plus className="h-4 w-4" />
            Add model
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
      <SectionTitle icon={<Trash2 className="h-4 w-4" />} title="Data" />
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

function SessionStatusDot({ status }: { status: SessionStatus }): JSX.Element {
  const color = status === "processing" ? "bg-accent-500" : status === "error" ? "bg-red-400" : status === "idle" ? "bg-mint-500" : "bg-slate-500";
  return <span title={status} className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
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
/models - Show model connections
/clear - Clear chat history
/help - Show this help message`;

export { App };

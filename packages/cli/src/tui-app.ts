/**
 * Clawflare TUI - A proper TUI interface using pi-tui components
 */

import { Chalk } from "chalk";
import {
  ProcessTerminal,
  TUI,
  Container,
  Text,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  type Component,
  type Focusable,
  type EditorTheme,
  type MarkdownTheme,
  type AutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { AgentClient, AgentMessage, ContextInfo, ToolInfo, ServerInfo, SessionResponse, SessionEvent } from "./client.js";
import { expandSkill, formatSkillsForPrompt, loadSkills, type AgentSkill } from "./skills.js";

const chalk = new Chalk({ level: 3 });

// Theme configuration - matching Pi's color scheme
const theme = {
  // Header
  header: (text: string) => chalk.bgBlue.white.bold(` ${text} `),

  // Status bar - no background, just passthrough (colors applied in setStatus)
  statusBar: (text: string) => text,

  // Messages - Pi style:
  // User prompts: white text (background applied via customBgFn in Text component)
  user: (text: string) => chalk.white(text),
  // AI replies: white text (no background)
  assistant: (text: string) => chalk.white(text),
  error: (text: string) => chalk.red(text),
  dim: (text: string) => chalk.gray(text),
  accent: (text: string) => chalk.magenta(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text: string) => chalk.dim(text),
  selectList: {
    selectedPrefix: (text: string) => chalk.blue(text),
    selectedText: (text: string) => chalk.bold(text),
    description: (text: string) => chalk.dim(text),
    scrollInfo: (text: string) => chalk.dim(text),
    noMatch: (text: string) => chalk.dim(text),
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

// Slash commands
const slashCommands = [
  { name: "new", description: "Start a new chat context" },
  { name: "fork", description: "Fork the current context" },
  { name: "name", description: "Name the current session" },
  { name: "tools", description: "List available tools" },
  { name: "clear", description: "Clear the chat history" },
  { name: "help", description: "Show help" },
  { name: "exit", description: "Exit the CLI" },
  { name: "cf_debug", description: "Debug DO storage for current session [key]" },
];

// Helper to get display message from SessionEvent
function getEventDisplayMessage(event: SessionEvent): string {
  switch (event.type) {
    case "tool_execution_start":
      return `Running ${event.toolName}`;
    case "tool_execution_end":
      return `${event.toolName} ${event.isError ? "failed" : "completed"}`;
    case "tool_execution_update":
      return `${event.toolName} updating...`;
    case "agent_start":
      return "Agent started";
    case "agent_end":
      return "Complete";
    case "turn_start":
      return "Turn started";
    case "turn_end":
      return "Turn completed";
    case "message_start":
      return "Generating response...";
    case "message_update":
    case "message_end":
      return "Response updated";
    default:
      return "Processing...";
  }
}

// Helper to create Text with 0 padding
function createText(content: string): Text {
  return new Text(content, 0, 0);
}

// Helper to create Markdown component for assistant messages
function createMarkdown(content: string, theme: MarkdownTheme): Markdown {
  // Default text style: white text on transparent background
  const defaultStyle = {
    color: (text: string) => chalk.white(text),
  };
  // paddingX: 2 (to align with the "🤖 " prefix), paddingY: 0
  return new Markdown(content, 2, 0, theme, defaultStyle);
}

type DisplayMessageRole = "user" | "assistant" | "toolResult" | "error";

type DisplayMessage = {
  role: DisplayMessageRole;
  content: string;
  usage?: { totalTokens: number; input: number; output: number };
  expanded?: boolean;
  toolName?: string;
  isError?: boolean;
};

// Helper to create user message block with full-width background and padding
function createUserBlock(content: string): Text {
  // Dark gray background for the entire block
  const bgFn = (text: string) => chalk.bgHex("#333333")(text);
  // paddingX: 1 (left/right), paddingY: 1 (top/bottom)
  return new Text(content, 1, 1, bgFn);
}

export class ClawflareTUIApp {
  private terminal: ProcessTerminal;
  private tui: TUI;
  private client: AgentClient;

  // UI Components
  private header: Text;
  private messageContainer: Container;
  private editor: Editor;
  private statusBar: Text;
  private loader?: Loader;

  // State
  private messages: DisplayMessage[] = [];
  private sessionId: string = "";
  private sessionName: string = "new";
  private isLoading = false;
  private error: string | null = null;
  private selectedMessageIndex: number = -1;
  private serverInfo: { url: string; provider?: string; model?: string; contextTotal?: number } = { url: "" };
  private lastUsage: { totalTokens: number; messageIndex: number } | null = null;
  private abortController: AbortController | null = null;
  private agentEvents: SessionEvent[] = [];
  private skills: AgentSkill[] = [];
  private skillsPrompt = "";
  
  // Track pending optimistic user message during processing
  private pendingUserMessage: DisplayMessage | null = null;
  private pendingMessageCount = 0;  // Counter to detect new server messages
  private sawProcessingStatus = false; // Track if we've seen processing during this poll

  // Estimate tokens using Pi's approach: chars/4 (conservative overestimate)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // Calculate context usage like Pi does:
  // Take last known usage + estimate tokens for messages after that
  private getContextUsage(): { tokens: number; contextWindow: number; percent: number } {
    const contextWindow = this.serverInfo.contextTotal || 128000;
    
    if (!this.lastUsage) {
      const tokens = this.messages.reduce((sum, msg) => 
        sum + this.estimateTokens(msg.content), 0);
      const percent = (tokens / contextWindow) * 100;
      return { tokens, contextWindow, percent };
    }
    
    let tokens = this.lastUsage.totalTokens;
    
    for (let i = this.lastUsage.messageIndex + 1; i < this.messages.length; i++) {
      tokens += this.estimateTokens(this.messages[i].content);
    }
    
    const percent = (tokens / contextWindow) * 100;
    return { tokens, contextWindow, percent };
  }
  
  private renderInterval?: NodeJS.Timeout;

  constructor(client: AgentClient) {
    this.client = client;
    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);
    this.serverInfo.url = client.getUrl();

    // Header
    this.header = createText("");
    this.tui.addChild(this.header);

    // Spacer
    this.tui.addChild(createText(""));

    // Message container
    this.messageContainer = new Container();
    this.tui.addChild(this.messageContainer);

    // Spacer to push editor to bottom
    this.tui.addChild(createText(""));

    // Editor for input
    this.editor = new Editor(this.tui, editorTheme, {
      paddingX: 1,
    });

    // Set up slash command autocomplete provider
    const slashCommandAutocomplete: AutocompleteProvider = {
      getSuggestions: async (lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }): Promise<AutocompleteSuggestions | null> => {
        const currentLine = lines[cursorLine] ?? "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        
        // Only trigger on slash at start of line
        if (!textBeforeCursor.startsWith("/")) {
          return null;
        }
        
        const query = textBeforeCursor.slice(1).toLowerCase();
        const matched = slashCommands.filter(cmd => 
          cmd.name.toLowerCase().startsWith(query) || cmd.name.toLowerCase().includes(query)
        );
        
        if (matched.length === 0) {
          return null;
        }
        
        const items: AutocompleteItem[] = matched.map(cmd => ({
          value: `/${cmd.name} `,
          label: `/${cmd.name}`,
          description: cmd.description,
        }));
        
        return {
          items,
          prefix: textBeforeCursor,
        };
      },
      
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      applyCompletion: (lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) => {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const newLine = beforeCursor + item.value + afterCursor;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforeCursor.length + item.value.length,
        };
      },
    };
    this.editor.setAutocompleteProvider(slashCommandAutocomplete);

    // Handle submissions
    this.editor.onSubmit = (value: string) => this.handleSubmit(value);

    // Add Ctrl+C handler
    this.tui.addInputListener((data: string) => {
      if (matchesKey(data, "ctrl+c")) {
        this.exit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d")) {
        this.exit();
        return { consume: true };
      }
      if (matchesKey(data, "esc")) {
        this.abortCurrentOperation();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o")) {
        this.toggleExpandSelectedMessage();
        return { consume: true };
      }
      // Only handle up/down for message navigation when autocomplete is not showing
    // Up/Down arrows are handled by the Editor for prompt history
    // Do not intercept them here
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor as Component & Focusable);

    // Status bar at bottom
    this.statusBar = createText("");
    this.tui.addChild(this.statusBar);

    // Initial data load
    this.loadInitialData();
  }

  private async loadInitialData(): Promise<void> {
    this.setStatus("Connecting...", "yellow");
    try {
      this.skills = loadSkills();
      this.skillsPrompt = formatSkillsForPrompt(this.skills);

      const serverInfo = await this.client.getServerInfo();
      this.serverInfo.provider = serverInfo.provider;
      this.serverInfo.model = serverInfo.model;
      this.serverInfo.contextTotal = serverInfo.contextWindow;
      
      const ctx = await this.client.createContext();
      this.sessionId = ctx.id;
      this.messages = [];
      this.updateHeader();
      this.renderMessages();
      this.setStatus("Connected", "green");
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Failed to connect";
      this.setStatus(`Error: ${this.error}`, "red");
    }
  }

  // Extract text content from message (handles both string and array formats)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractContent(content: string | Array<any>): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    }
    return String(content);
  }

  // Check if message contains tool calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hasToolCalls(content: string | Array<any>): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((c) => c.type === "toolCall");
  }

  // Get tool call names from message content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getToolCallNames(content: string | Array<any>): string[] {
    if (!Array.isArray(content)) return [];
    return content
      .filter((c) => c.type === "toolCall")
      .map((c) => c.name || "tool")
      .filter((name, index, arr) => arr.indexOf(name) === index); // dedupe
  }

  private toDisplayRole(role: string): DisplayMessageRole {
    if (role === "user" || role === "assistant" || role === "toolResult") return role;
    return "error";
  }

  private formatMessageForDisplay(message: AgentMessage): DisplayMessage {
    const role = this.toDisplayRole(message.role);
    const rawContent = this.extractContent(message.content);
    const content = this.stripSkillsPrefix(rawContent);

    if (role === "assistant" && this.hasToolCalls(message.content)) {
      const toolNames = this.getToolCallNames(message.content);
      // If there's text content, show it; otherwise show that tools are being called
      const displayContent = content || `Calling ${toolNames.join(", ")}...`;
      return { role, content: displayContent };
    }

    if (role !== "toolResult") {
      return { role, content };
    }

    const toolMessage = message as AgentMessage & {
      toolName?: string;
      isError?: boolean;
    };
    const toolName = toolMessage.toolName || "tool";

    return {
      role: "toolResult",
      toolName,
      isError: Boolean(toolMessage.isError),
      content: `${toolName}: ${content}`,
    };
  }

  // Strip skills prompt prefix from displayed user messages
  private stripSkillsPrefix(content: string): string {
    if (!this.skillsPrompt) return content;
    const prefix = this.skillsPrompt + "\n\n";
    if (content.startsWith(prefix)) {
      return content.slice(prefix.length);
    }
    return content;
  }

  private updateHeader(): void {
    const title = "Clawflare AI Chat";
    const contextInfo = this.sessionId ? ` [${this.sessionId.slice(0, 8)}] ` : "";
    const headerText = theme.header(title + contextInfo);
    this.header.setText(headerText);
  }

  private renderMessages(): void {
    // Clear current messages
    this.messageContainer.clear();

    // Show welcome if empty
    if (this.messages.length === 0 && !this.isLoading) {
      this.messageContainer.addChild(
        createText(theme.dim("Welcome to Clawflare! Type a message to start chatting."))
      );
    }

    // Add each message
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      const isSelected = i === this.selectedMessageIndex;

      // Show full content if selected+expanded, otherwise truncate
      let displayContent = msg.content;
      // Higher limit for assistant messages with markdown (they may contain tables)
      const maxLen = msg.role === "assistant" ? 8000 : 500;
      const wasTruncated = displayContent.length > maxLen;
      const isExpanded = isSelected && msg.expanded;
      
      if (wasTruncated && !isExpanded) {
        // Try to truncate at a line boundary to avoid breaking tables
        let truncateAt = maxLen;
        const nextNewline = displayContent.indexOf("\n", maxLen - 100);
        if (nextNewline !== -1 && nextNewline < maxLen + 200) {
          truncateAt = nextNewline;
        }
        displayContent = displayContent.substring(0, truncateAt) + "\n" + theme.dim("... (truncated, press Ctrl+O to expand)");
      }

      // Add selection indicator if selected
      const indicator = isSelected ? theme.accent("▶ ") : "  ";

      // Use full-width block with background for user messages
      if (msg.role === "user") {
        const prefix = "❱ ";
        this.messageContainer.addChild(createUserBlock(theme.user(indicator + prefix + displayContent)));
      } else if (msg.role === "assistant") {
        // Use Markdown component for assistant messages with proper formatting
        const prefix = indicator + "🤖 ";
        // Add the prefix as a plain text line, then the markdown content
        if (prefix.trim()) {
          this.messageContainer.addChild(createText(prefix));
        }
        this.messageContainer.addChild(createMarkdown(displayContent, markdownTheme));
      } else if (msg.role === "toolResult") {
        const prefix = msg.isError ? "❌ " : "🔧 ";
        const colorFn = msg.isError ? theme.error : theme.dim;
        this.messageContainer.addChild(createText(colorFn(indicator + prefix + displayContent)));
      } else {
        // error role
        this.messageContainer.addChild(createText(theme.error(indicator + "⚠ " + displayContent)));
      }
    }

    // Show loading if needed
    if (this.isLoading) {
      this.messageContainer.addChild(createText(""));
      const eventLines = this.getProcessingLines();
      this.messageContainer.addChild(createText(theme.dim(eventLines.join("\n"))));
    }

    // Show error if any
    if (this.error) {
      this.messageContainer.addChild(createText(""));
      this.messageContainer.addChild(createText(theme.error(` Error: ${this.error} `)));
    }

    this.messageContainer.invalidate();
  }

  private formatEventLine(event: SessionEvent): string {
    const icon = event.type === "tool_execution_start" ? "🔧" :
      event.type === "tool_execution_end" ? (event.isError ? "❌" : "✓") :
      event.type === "agent_end" ? "✓" :
      "○";
    return `  ${icon} ${getEventDisplayMessage(event)}`;
  }

  private getProcessingLines(): string[] {
    if (this.agentEvents.length === 0) {
      return ["Processing... waiting for updates"];
    }

    const recent = this.agentEvents.slice(-20);
    const messageEventCount = recent.filter((event) => this.isAssistantMessageEvent(event)).length;
    const nonMessageEvents = recent.filter((event) => !this.isAssistantMessageEvent(event));
    const lines = ["Processing:"];

    for (const event of nonMessageEvents.slice(-6)) {
      lines.push(this.formatEventLine(event));
    }

    if (messageEventCount > 0) {
      lines.push(`  ○ Generating response... ${messageEventCount} update${messageEventCount === 1 ? "" : "s"}`);
    }

    return lines;
  }

  private isAssistantMessageEvent(event: SessionEvent): boolean {
    return event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end";
  }

  private setStatus(statusText: string, color: "green" | "yellow" | "red" | "gray" | "blue" = "gray"): void {
    const colorFn = {
      green: chalk.green,
      yellow: chalk.yellow,
      red: chalk.red,
      gray: chalk.gray,
      blue: chalk.blue,
    }[color];

    const { contextWindow, percent } = this.getContextUsage();
    const contextDisplay = `${percent.toFixed(1)}%/${Math.round(contextWindow / 1000)}k`;
    
    const providerModel = this.serverInfo.provider && this.serverInfo.model 
      ? `${this.serverInfo.provider} ● ${this.serverInfo.model}` 
      : "";
    
    const width = this.terminal.columns;
    const bigDot = "●";
    
    // Line 1: session name ● endpoint  [right]  provider ● model
    // Line 2: status ● context%
    
    const left1 = chalk.gray(`${this.sessionName} ${bigDot} ${this.serverInfo.url || "unknown"}`);
    const right1 = providerModel ? chalk.gray(providerModel) : "";
    const line1 = this.formatStatusLine(left1, right1, width);
    
    const left2 = `${colorFn(statusText)} ${chalk.gray(bigDot)} ${chalk.gray(contextDisplay)}`;
    const right2 = "";
    const line2 = this.formatStatusLine(left2, right2, width);
    
    const fullStatus = `${line1}\n${line2}`;
    this.statusBar.setText(theme.statusBar(fullStatus));
  }

  // Format a line with left and right content, filling the middle with spaces
  private formatStatusLine(left: string, right: string, width: number): string {
    const contentWidth = Math.max(1, width - 2);
    const leftVisible = this.visibleWidthAnsi(left);
    const rightVisible = this.visibleWidthAnsi(right);
    
    if (rightVisible === 0) {
      return left;
    }
    
    const padding = Math.max(1, contentWidth - leftVisible - rightVisible);
    return left + " ".repeat(padding) + right;
  }

  // Calculate visible width of text, stripping ANSI codes
  private visibleWidthAnsi(text: string): number {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  private handleSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;

    (this.editor as unknown as { addToHistory(text: string): void }).addToHistory(trimmed);

    // Handle slash commands
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(" ");
      const command = parts[0];
      const args = parts.slice(1).join(" ");
      this.handleSlashCommand(command, args);
      return;
    }

    this.sendPrompt(trimmed, this.withSkillsSummary(trimmed));
  }

  private updateAgentEvents(events: SessionEvent[]): void {
    this.agentEvents = [...this.agentEvents, ...events];
    this.renderMessages();
    
    const lastEvent = events.at(-1);
    if (lastEvent) {
      const statusText = getEventDisplayMessage(lastEvent);
      this.setStatus(statusText, "yellow");
    }
  }

  private sendPrompt(displayContent: string, actualContent: string): void {
    // Don't allow new messages while loading
    if (this.isLoading) return;

    // Clear editor
    this.editor.setText("");

    // Add user message optimistically - but also track it
    this.pendingUserMessage = { role: "user", content: displayContent };
    this.pendingMessageCount = this.messages.length;
    this.sawProcessingStatus = false;
    
    this.messages.push({ role: "user", content: displayContent });
    this.isLoading = true;
    this.error = null;
    this.agentEvents = [];
    this.renderMessages();
    this.setStatus("Submitting... (Esc to abort)", "yellow");

    // Create abort controller
    this.abortController = new AbortController();
    const requestAbortController = this.abortController;

    // Fire off the session-based chat request
    this.client.submitChat({
      type: "prompt",
      content: actualContent,
      sessionId: this.sessionId,
    }).then((submitted) => {
      this.sessionId = submitted.sessionId;
      this.updateHeader();
      this.setStatus(`Session ${submitted.sessionId.slice(0, 8)}: processing...`, "yellow");
      
      // Start polling for events/messages
      return this.pollSession(submitted.sessionId, requestAbortController.signal, submitted.eventCursor);
    }).then(() => {
      this.setStatus("Complete", "green");
    }).catch((e) => {
      if (e instanceof Error && e.name === "AbortError" && requestAbortController.signal.aborted) {
        return;
      }
      this.error = e instanceof Error ? e.message : "Unknown error";
      this.messages.push({ role: "error", content: this.error });
      this.setStatus("Error", "red");
    }).finally(() => {
      this.isLoading = false;
      this.pendingUserMessage = null;
      this.pendingMessageCount = 0;
      this.sawProcessingStatus = false;
      this.abortController = null;
      this.agentEvents = [];
      this.renderMessages();
    });
  }

  private async pollSession(sessionId: string, signal?: AbortSignal, initialCursor?: string): Promise<void> {
    // Track whether we've seen processing status - defensive check against stale idle
    for await (const update of this.client.streamSession(sessionId, signal, { initialCursor })) {
      // Track if we've seen processing status during this poll cycle
      if (update.session.status === "processing") {
        this.sawProcessingStatus = true;
      }
      
      // Only treat idle as complete if we've seen evidence of processing
      // (new events, message count increased, or status was processing)
      const hasNewEvents = update.newEvents.length > 0;
      const hasMoreMessages = update.session.messages.length > this.pendingMessageCount;
      const safeToComplete = this.sawProcessingStatus || hasNewEvents || hasMoreMessages;
      
      // Defensive: don't accept idle until we've seen evidence this submit was processed
      const actuallyComplete = update.complete && (safeToComplete || update.session.status === "error");
      
      // Update messages (conversation history)
      // If we have a pending optimistic message, check if server caught up
      const serverMessages = update.session.messages.map((m) => this.formatMessageForDisplay(m));
      
      if (this.pendingUserMessage && !this.messagesHaveUserMessage(serverMessages, this.pendingUserMessage)) {
        // Server hasn't caught up yet - show server messages + our pending message
        this.messages = [...serverMessages, this.pendingUserMessage];
      } else {
        // Server is caught up or no pending message - use server messages directly
        if (this.pendingUserMessage) {
          this.pendingUserMessage = null; // Successfully reconciled
        }
        this.messages = serverMessages;
      }
      
      // Update events for progress display
      if (update.newEvents.length > 0) {
        this.updateAgentEvents(update.newEvents);
      }
      
      // Check if complete
      if (actuallyComplete) {
        if (update.session.status === "error") {
          this.error = update.session.errorMessage || "Processing failed";
          this.messages.push({ role: "error", content: this.error });
        }
        break;
      }
    }
  }

  // Check if server messages contain content matching our pending optimistic message
  private messagesHaveUserMessage(serverMessages: DisplayMessage[], pendingMessage: DisplayMessage): boolean {
    // Compare by content - if any user message matches our pending content, consider it reconciled
    return serverMessages.some((m) => 
      m.role === "user" && 
      m.content.trim() === pendingMessage.content.trim()
    );
  }

  private withSkillsSummary(prompt: string): string {
    if (!this.skillsPrompt) return prompt;
    return `${this.skillsPrompt}\n\n${prompt}`;
  }

  private abortCurrentOperation(): void {
    if (this.abortController && this.isLoading) {
      this.abortController.abort();
      this.messages.push({ role: "assistant", content: "⚠ Operation aborted by user" });
      this.isLoading = false;
      this.abortController = null;
      this.agentEvents = [];
      this.renderMessages();
      this.setStatus("Aborted", "yellow");
    }
  }

  private toggleExpandSelectedMessage(): void {
    if (this.messages.length === 0) return;
    
    if (this.selectedMessageIndex < 0) {
      // First press: select the last message AND expand it
      this.selectedMessageIndex = this.messages.length - 1;
      const msg = this.messages[this.selectedMessageIndex]!;
      msg.expanded = true;
    } else if (this.selectedMessageIndex < this.messages.length) {
      // Subsequent presses: toggle expand on the selected message
      const msg = this.messages[this.selectedMessageIndex]!;
      msg.expanded = !msg.expanded;
    }
    this.renderMessages();
  }

  private selectPreviousMessage(): void {
    if (this.messages.length === 0) return;
    this.selectedMessageIndex = Math.max(0, this.selectedMessageIndex - 1);
    this.renderMessages();
  }

  private selectNextMessage(): void {
    if (this.messages.length === 0) return;
    this.selectedMessageIndex = Math.min(this.messages.length - 1, this.selectedMessageIndex + 1);
    this.renderMessages();
  }

  private handleSlashCommand(command: string, args: string): void {
    // Clear the editor after slash command
    this.editor.setText("");

    void (async () => {
      if (command.startsWith("skill:")) {
        const skillName = command.slice("skill:".length);
        const skill = this.skills.find((candidate) => candidate.name === skillName);
        if (!skill) {
          this.error = `Unknown skill: ${skillName}`;
          this.renderMessages();
          this.setStatus(`Unknown skill: ${skillName}`, "red");
          return;
        }
        const display = `⚙ skill: ${skill.name}${args ? ` ${args}` : ""}`;
        this.sendPrompt(display, this.withSkillsSummary(expandSkill(skill, args)));
        return;
      }

      switch (command) {
        case "new":
          this.setStatus("Creating new context...", "yellow");
          try {
            const ctx = await this.client.createContext();
            this.sessionId = ctx.id;
            this.messages = [];
            this.updateHeader();
            this.renderMessages();
            this.setStatus("New context created", "green");
          } catch (e) {
            this.error = e instanceof Error ? e.message : "Failed to create context";
            this.renderMessages();
            this.setStatus(`Error: ${this.error}`, "red");
          }
          break;

        case "fork":
          this.setStatus("Forking context...", "yellow");
          try {
            const ctx = await this.client.forkContext();
            this.sessionId = ctx.id;
            this.messages = ctx.messages.map((m) => this.formatMessageForDisplay(m));
            this.updateHeader();
            this.renderMessages();
            this.setStatus("Context forked", "green");
          } catch (e) {
            this.error = e instanceof Error ? e.message : "Failed to fork context";
            this.renderMessages();
            this.setStatus(`Error: ${this.error}`, "red");
          }
          break;

        case "name":
          if (!args) {
            this.error = "Usage: /name <session-name>";
            this.renderMessages();
            this.setStatus("Error", "red");
          } else {
            this.sessionName = args.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
            this.messages.push({
              role: "assistant",
              content: `Session renamed to: ${this.sessionName}`,
            });
            this.renderMessages();
            this.setStatus("Ready", "green");
          }
          break;

        case "tools":
          this.setStatus("Loading tools...", "yellow");
          try {
            const tools = await this.client.listTools();
            const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
            this.messages.push({
              role: "assistant",
              content: `Available tools:\n${toolList}`,
            });
            this.renderMessages();
            this.setStatus("Ready", "green");
          } catch (e) {
            this.error = e instanceof Error ? e.message : "Failed to load tools";
            this.renderMessages();
            this.setStatus(`Error: ${this.error}`, "red");
          }
          break;

        case "clear":
          this.messages = [];
          this.renderMessages();
          this.setStatus("Chat cleared", "green");
          break;

        case "help":
          this.messages.push({
            role: "assistant",
            content: `Commands:
/new - Start a new chat context
/fork - Fork the current context
/name <name> - Name the current session
/tools - List available tools
/skill:<name> [args] - Invoke a local Agent Skill
/cf_debug [key] - Debug DO storage for current session
/clear - Clear chat history
/exit - Exit the CLI
/help - Show this help message

Shortcuts:
Ctrl+C or Ctrl+D - Quit
Esc - Abort current operation
↑/↓ - Select message (or navigate autocomplete)
Ctrl+O - Expand/collapse selected message`,
          });
          this.renderMessages();
          break;

        case "cf_debug":
          this.setStatus("Fetching debug info...", "yellow");
          try {
            // args contains optional key
            const keyArg = args.trim() || undefined;
            const debugData = await this.client.cfDebug(this.sessionId, keyArg);
            this.messages.push({
              role: "assistant",
              content: `Debug info for session ${this.sessionId.slice(0, 8)}:\n\`\`\`json\n${JSON.stringify(debugData, null, 2).slice(0, 8000)}\n\`\`\``,
            });
            this.renderMessages();
            this.setStatus("Debug info loaded", "green");
          } catch (e) {
            this.error = e instanceof Error ? e.message : "Debug query failed";
            this.messages.push({
              role: "error",
              content: this.error,
            });
            this.renderMessages();
            this.setStatus("Debug failed", "red");
          }
          break;

        case "exit":
          this.exit();
          break;

        default:
          this.error = `Unknown command: /${command}`;
          this.renderMessages();
          this.setStatus(`Unknown command: /${command}`, "red");
      }
    })();
  }

  start(): void {
    // Start periodic render to catch async state changes
    // Reduced to 500ms to minimize full redraw triggers
    this.renderInterval = setInterval(() => {
      this.tui.requestRender();
    }, 500);
    this.tui.start();
  }

  exit(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }
    this.tui.stop();
    process.exit(0);
  }
}

// Factory function
export function createTUI(client: AgentClient): ClawflareTUIApp {
  return new ClawflareTUIApp(client);
}

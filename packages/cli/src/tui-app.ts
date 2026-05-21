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
  Box,
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

  // Messages - brighter colors from pi-coding-agent theme:
  // User prompts: white text (background applied via customBgFn in Text component)
  user: (text: string) => chalk.white(text),
  // AI replies: default bright text
  assistant: (text: string) => text,
  // Errors: bright red from pi theme
  error: (text: string) => chalk.hex("#cc6666")(text),
  // Muted: brighter gray from pi theme
  dim: (text: string) => chalk.hex("#808080")(text),
  // Accent: cyan-teal from pi theme
  accent: (text: string) => chalk.hex("#8abeb7")(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text: string) => chalk.hex("#505050")(text),
  selectList: {
    selectedPrefix: (text: string) => chalk.hex("#5f87ff")(text),
    selectedText: (text: string) => chalk.bold(text),
    description: (text: string) => chalk.hex("#808080")(text),
    scrollInfo: (text: string) => chalk.hex("#808080")(text),
    noMatch: (text: string) => chalk.hex("#808080")(text),
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.hex("#f0c674")(text),
  link: (text: string) => chalk.hex("#81a2be")(text),
  linkUrl: (text: string) => chalk.hex("#808080")(text),
  code: (text: string) => chalk.hex("#8abeb7")(text),
  codeBlock: (text: string) => chalk.hex("#b5bd68")(text),
  codeBlockBorder: (text: string) => chalk.hex("#808080")(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.hex("#808080")(text),
  hr: (text: string) => chalk.hex("#808080")(text),
  listBullet: (text: string) => chalk.hex("#8abeb7")(text),
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

function createBlockGap(): Text {
  return new Text("", 0, 1);
}

// ASCII spinner frames for "Thinking" animation
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Format tool call for human-friendly display based on tool type
function formatToolCallHeader(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "execute_code": {
      const desc = params.description as string | undefined;
      const code = params.code as string | undefined;
      if (desc) {
        return `Execute: ${desc}`;
      }
      if (code) {
        const truncated = code.slice(0, 30).replace(/\n/g, " ");
        return `Execute: ${truncated}${code.length > 30 ? "..." : ""}`;
      }
      return "Execute code";
    }

    case "execute_stored_code": {
      const name = params.name as string | undefined;
      const desc = params.description as string | undefined;
      if (name && desc) {
        return `Run ${name}: ${desc}`;
      }
      if (name) {
        return `Run ${name}`;
      }
      return "Execute stored code";
    }

    case "store_code": {
      const name = params.name as string | undefined;
      const desc = params.description as string | undefined;
      if (name && desc) {
        return `Store ${name}: ${desc}`;
      }
      if (name) {
        return `Store ${name}`;
      }
      return "Store code";
    }

    case "search": {
      const query = params.query as string | undefined;
      const collection = params.collection as string | undefined;
      if (query && collection && collection !== "all") {
        return `Search ${collection}: "${query}"`;
      }
      if (query) {
        return `Search: "${query}"`;
      }
      return "Search";
    }

    // Container tools
    case "container_bash": {
      const command = params.command as string | undefined;
      const cwd = params.cwd as string | undefined;
      if (command) {
        const display = command.length > 40 ? `${command.slice(0, 40)}...` : command;
        const cwdInfo = cwd ? ` (cwd: ${cwd})` : "";
        return `container_bash: "${display}"${cwdInfo}`;
      }
      return "container_bash";
    }

    case "container_ls": {
      const path = params.path as string | undefined;
      const recursive = params.recursive as boolean | undefined;
      const pathDisplay = path || ".";
      const recursiveFlag = recursive ? " -R" : "";
      return `container_ls: ${pathDisplay}${recursiveFlag}`;
    }

    case "container_read": {
      const path = params.path as string | undefined;
      const startLine = params.startLine as number | undefined;
      const endLine = params.endLine as number | undefined;
      if (path) {
        const range = startLine && endLine ? ` [${startLine}-${endLine}]` : "";
        return `container_read: ${path}${range}`;
      }
      return "container_read";
    }

    case "container_write": {
      const path = params.path as string | undefined;
      const append = params.append as boolean | undefined;
      if (path) {
        const action = append ? ">>" : ">";
        return `container_write: ${action} ${path}`;
      }
      return "container_write";
    }

    case "container_edit": {
      const path = params.path as string | undefined;
      const replaceAll = params.replaceAll as boolean | undefined;
      if (path) {
        const mode = replaceAll ? " (replace all)" : " (replace one)";
        return `container_edit: ${path}${mode}`;
      }
      return "container_edit";
    }

    case "container_grep": {
      const pattern = params.pattern as string | undefined;
      const path = params.path as string | undefined;
      const include = params.include as string | undefined;
      const parts: string[] = [];
      if (pattern) parts.push(`"${pattern}"`);
      if (path && path !== ".") parts.push(`in: ${path}`);
      if (include) parts.push(`include: ${include}`);
      if (parts.length > 0) {
        return `container_grep: ${parts.join(", ")}`;
      }
      return "container_grep";
    }

    case "container_find": {
      const name = params.name as string | undefined;
      const type = params.type as string | undefined;
      const path = params.path as string | undefined;
      const parts: string[] = [];
      if (name) parts.push(`name: "${name}"`);
      if (type && type !== "any") parts.push(`type: ${type}`);
      if (path && path !== ".") parts.push(`in: ${path}`);
      if (parts.length > 0) {
        return `container_find: ${parts.join(", ")}`;
      }
      return "container_find";
    }

    case "container_create": {
      const containerId = params.containerId as string | undefined;
      const description = params.description as string | undefined;
      if (description) {
        return `container_create: ${description}`;
      }
      if (containerId) {
        return `container_create: ${containerId.slice(0, 16)}...`;
      }
      return "container_create";
    }

    default: {
      // Generic fallback for unknown tools
      const entries = Object.entries(params)
        .filter(([key]) => key !== "maxResponseLength")
        .slice(0, 2);
      if (entries.length === 0) return toolName;
      const formatted = entries.map(([k, v]) => {
        if (typeof v === "string") return `"${v.slice(0, 20)}${v.length > 20 ? "..." : ""}"`;
        return String(v);
      }).join(", ");
      return `${toolName}(${formatted})`;
    }
  }
}

// Extract params from tool call content
function extractToolCallParams(content: string): { description?: string; [key: string]: unknown } {
  try {
    // Try to parse as JSON if the content looks like JSON
    const trimmed = content.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      return JSON.parse(trimmed);
    }
  } catch {
    // Fall through
  }
  return {};
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

export type ToolCallStatus = "pending" | "running";

export function getPersistedToolResultIsError(toolResult: { isError?: boolean; details?: unknown }): boolean {
  const details = toolResult.details;
  return Boolean(toolResult.isError) ||
    (typeof details === "object" && details !== null && "ok" in details && details.ok === false);
}

export function getToolCallVisualState(
  status: ToolCallStatus,
  toolResult: { isError?: boolean } | undefined
): { hasError: boolean; isComplete: boolean } {
  void status;
  const hasError = toolResult?.isError === true;
  const isComplete = toolResult !== undefined && !hasError;
  return { hasError, isComplete };
}

interface ToolCallInfo {
  id: string;
  name: string;
  params: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  isError?: boolean;
  expanded?: boolean; // For UI expand/collapse
}

// Helper to get line count of content
function getLineCount(content: string): number {
  return content.split('\n').length;
}

// Helper to truncate content to N lines
function truncateToLines(content: string, lines: number): string {
  const allLines = content.split('\n');
  if (allLines.length <= lines) return content;
  return allLines.slice(0, lines).join('\n') + '\n...';
}

function getStringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function getToolCallCode(toolCall: ToolCallInfo, toolResult: DisplayMessage | undefined): string | undefined {
  if (toolCall.name === "execute_code") {
    return typeof toolCall.params.code === "string" ? toolCall.params.code : undefined;
  }
  if (toolCall.name === "execute_stored_code") {
    return getStringProp(toolResult?.details, "executedCode");
  }
  return undefined;
}

function codeNeedsCollapse(code: string): boolean {
  return getLineCount(code) > 12 || code.length > 4_000;
}

function collapsedCode(code: string): string {
  const byLine = truncateToLines(code, 12);
  if (byLine.length <= 4_000) return byLine;
  return `${byLine.slice(0, 4_000)}\n...`;
}

type DisplayMessage = {
  role: DisplayMessageRole;
  content: string;
  usage?: { totalTokens: number; input: number; output: number };
  expanded?: boolean;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  // For assistant messages with tool calls
  toolCalls?: ToolCallInfo[];
};

// Helper to create user message block with full-width background and padding
function createUserBlock(content: string): Text {
  // Dark gray background for the entire block (pi-coding-agent user message bg)
  const bgFn = (text: string) => chalk.bgHex("#343541")(text);
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

  // Extract tool calls from message content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractToolCalls(content: string | Array<any>): ToolCallInfo[] {
    if (!Array.isArray(content)) return [];
    return content
      .filter((c) => c.type === "toolCall")
      .map((c) => ({
        id: c.id || "",
        name: c.name || "tool",
        params: c.arguments || {}, // ToolCall uses "arguments", not "args"
        status: "pending" as ToolCallStatus,
      }));
  }

  // Get text content from message (excluding tool calls)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getTextContent(content: string | Array<any>): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    }
    return "";
  }

  private toDisplayRole(role: string): DisplayMessageRole {
    if (role === "user" || role === "assistant" || role === "toolResult") return role;
    return "error";
  }

  private formatMessageForDisplay(message: AgentMessage): DisplayMessage {
    const role = this.toDisplayRole(message.role);

    if (role === "assistant") {
      const textContent = this.getTextContent(message.content);
      const displayText = this.stripSkillsPrefix(textContent);

      // Extract tool calls if present
      let toolCalls: ToolCallInfo[] | undefined;
      if (this.hasToolCalls(message.content)) {
        toolCalls = this.extractToolCalls(message.content);
      }

      return {
        role,
        content: displayText || "",
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      };
    }

    const rawContent = this.extractContent(message.content);
    const content = this.stripSkillsPrefix(rawContent);

    if (role !== "toolResult") {
      return { role, content };
    }

    const toolMessage = message as AgentMessage & {
      toolName?: string;
      isError?: boolean;
      details?: unknown;
    };
    const toolName = toolMessage.toolName || "tool";

    return {
      role: "toolResult",
      toolName,
      isError: getPersistedToolResultIsError(toolMessage),
      details: toolMessage.details,
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

    // Associate tool results with their corresponding tool calls
    // Tool results come in the same order as tool calls, so match by position
    const toolResultMap = new Map<string, DisplayMessage>();
    
    // Track which tool call index we're at for each assistant message
    const assistantToolCallIndex = new Map<number, number>();
    
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (msg.role === "toolResult" && msg.toolName) {
        // Find the most recent assistant message before this that has tool calls
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = this.messages[j]!;
          if (prevMsg.role === "assistant" && prevMsg.toolCalls && prevMsg.toolCalls.length > 0) {
            // Get current index for this assistant
            const currentIdx = assistantToolCallIndex.get(j) || 0;
            if (currentIdx < prevMsg.toolCalls.length) {
              const key = `${j}:${currentIdx}`;
              toolResultMap.set(key, msg);
              assistantToolCallIndex.set(j, currentIdx + 1);
            }
            break; // Only match to the most recent assistant
          }
        }
      }
    }

    // Add each message
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;

      // Skip toolResults that have been mapped to tool calls (they'll be rendered inline)
      if (msg.role === "toolResult") {
        continue;
      }

      // Use full-width block with background for user messages
      if (msg.role === "user") {
        const prefix = "❱ ";
        this.messageContainer.addChild(createUserBlock(theme.user(prefix + msg.content)));
        this.messageContainer.addChild(createBlockGap());
        
        // Show "Thinking" spinner right after the last user message when loading
        if (this.isLoading && i === this.messages.length - 1) {
          this.renderThinkingIndicator("");
        }
      } else if (msg.role === "assistant") {
        const termHeight = this.terminal.rows;
        const isLastAssistant = i === this.messages.length - 1;
        const showThinking = this.isLoading && isLastAssistant && !msg.content && !msg.toolCalls;

        if (showThinking) {
          this.renderThinkingIndicator("");
        } else {
          // Show assistant text content if present
          if (msg.content) {
            const contentLines = getLineCount(msg.content);
            const shouldCollapse = contentLines > termHeight;
            
            if (shouldCollapse && !msg.expanded) {
              // Show collapsed to 10 lines
              const collapsed = truncateToLines(msg.content, 10);
              this.messageContainer.addChild(createMarkdown(collapsed, markdownTheme));
              this.messageContainer.addChild(createText(theme.dim(`  (${contentLines - 10} more lines, Ctrl+O to expand)`)));
              this.messageContainer.addChild(createBlockGap());
            } else {
              // Show full content
              this.messageContainer.addChild(createMarkdown(msg.content, markdownTheme));
              this.messageContainer.addChild(createBlockGap());
            }
          }
        }

        // Render tool calls if present
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Add spacing between assistant text and tool calls
          this.messageContainer.addChild(createBlockGap());
          for (let ti = 0; ti < msg.toolCalls.length; ti++) {
            const toolCall = msg.toolCalls[ti]!;
            const key = `${i}:${ti}`;
            const toolResult = toolResultMap.get(key);
            this.renderToolCallBlock(toolCall, toolResult, "", termHeight);
          }
        }
      } else {
        // error role
        this.messageContainer.addChild(createText(theme.error("⚠ " + msg.content)));
        this.messageContainer.addChild(createBlockGap());
      }
    }

    // Show thinking indicator when loading but no messages yet at all
    if (this.isLoading && this.messages.length === 0) {
      this.renderThinkingIndicator("");
    }

    // Show error if any
    if (this.error) {
      this.messageContainer.addChild(createText(""));
      this.messageContainer.addChild(createText(theme.error(` Error: ${this.error} `)));
    }

    this.messageContainer.invalidate();
  }

  private renderThinkingIndicator(indent: string): void {
    // Use a Loader component for automatic animation
    const loader = new Loader(
      this.tui,
      (text: string) => chalk.hex("#5f87ff")(text),  // spinner color (pi blue)
      (text: string) => chalk.hex("#808080")(text),   // message color (brighter gray)
      "Thinking",
      { frames: SPINNER_FRAMES, intervalMs: 80 }
    );
    loader.start();
    this.messageContainer.addChild(loader);
  }

  private renderToolCallBlock(toolCall: ToolCallInfo, toolResult: DisplayMessage | undefined, indent: string, termHeight: number): void {
    // Persisted tool result messages are the source of truth for completion/error.
    // Event-derived status is only used for pending/running while no result exists yet.
    const { hasError, isComplete } = getToolCallVisualState(toolCall.status, toolResult);
    
    // Background colors based on status - subtle like pi-coding-agent theme
    // In-flight: very subtle dark blue-gray
    const inFlightBgFn = (text: string) => chalk.bgHex("#282832")(text);
    // Complete: very subtle dark green-gray
    const completeBgFn = (text: string) => chalk.bgHex("#283228")(text);
    // Error: subtle dark red-gray
    const errorBgFn = (text: string) => chalk.bgHex("#3c2828")(text)

    const getBgFn = () => {
      if (hasError) return errorBgFn;
      if (isComplete) return completeBgFn;
      return inFlightBgFn;
    };

    const statusIcon = isComplete ? "✓" :
                       hasError ? "✗" : "●";
    const iconColor = isComplete ? chalk.green :
                      hasError ? chalk.red : chalk.cyan;

    const headerText = formatToolCallHeader(toolCall.name, toolCall.params);
    const header = `${indent}${iconColor(statusIcon)} ${chalk.bold.white(headerText)}`;

    // Create a box with the appropriate background
    const box = new Box(2, 1, getBgFn());
    box.addChild(createText(header));

    const code = getToolCallCode(toolCall, toolResult);
    if (code) {
      const isExpanded = toolCall.expanded ?? false;
      const shouldCollapseCode = codeNeedsCollapse(code);
      const codeText = shouldCollapseCode && !isExpanded ? collapsedCode(code) : code;
      const codePrefix = `${indent}  `;

      box.addChild(createText("")); // Spacer
      box.addChild(createText(codePrefix + chalk.hex("#808080")("Code:")));
      for (const line of codeText.split('\n')) {
        box.addChild(createText(codePrefix + line));
      }
      if (shouldCollapseCode && !isExpanded) {
        box.addChild(createText(codePrefix + theme.dim("(code truncated, Ctrl+O to expand)")));
      }
    }

    // Show tool result content if available
    if (toolResult && toolResult.content) {
      const resultText = toolResult.content;
      const contentLines = getLineCount(resultText);
      const shouldCollapse = contentLines > termHeight;
      const isExpanded = toolCall.expanded ?? false;
      const resultPrefix = `${indent}  `;
      
      box.addChild(createText("")); // Spacer
      
      if (shouldCollapse && !isExpanded) {
        // Collapse to 10 lines
        const collapsed = truncateToLines(resultText, 10);
        const lines = collapsed.split('\n');
        for (const line of lines) {
          box.addChild(createText(resultPrefix + line));
        }
        box.addChild(createText(resultPrefix + theme.dim(`(${contentLines - 10} more lines, Ctrl+O to expand)`)));
      } else {
        // Show full result
        const lines = resultText.split('\n');
        for (const line of lines) {
          box.addChild(createText(resultPrefix + line));
        }
      }
    }

    this.messageContainer.addChild(box);
    this.messageContainer.addChild(createBlockGap());
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

    // Update tool call statuses based on events
    this.updateToolCallStatuses(events);

    this.renderMessages();

    const lastEvent = events.at(-1);
    if (lastEvent) {
      const statusText = getEventDisplayMessage(lastEvent);
      this.setStatus(statusText, "yellow");
    }
  }

  private updateToolCallStatuses(events: SessionEvent[]): void {
    const lastAssistantIdx = this.getLastAssistantMessageIndex();
    if (lastAssistantIdx === -1 || !this.messages[lastAssistantIdx]?.toolCalls) return;

    const msg = this.messages[lastAssistantIdx]!;
    if (!msg.toolCalls) return;

    for (const event of events) {
      if (event.type === "tool_execution_start" && event.toolCallId) {
        const toolCall = msg.toolCalls.find((tc) => tc.id === event.toolCallId);
        if (toolCall) {
          toolCall.status = "running";
        }
      }
    }
  }

  private getLastAssistantMessageIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === "assistant") {
        return i;
      }
    }
    return -1;
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
    
    // Toggle expanded state for ALL expandable blocks (messages and tool calls)
    // First determine what state we're toggling to
    const anyExpanded = this.messages.some(m => m.expanded) || 
      this.messages.some(m => m.toolCalls?.some(tc => tc.expanded));
    const newExpanded = !anyExpanded;
    
    // Apply to all messages
    for (const msg of this.messages) {
      // For assistant messages with content
      if (msg.role === "assistant" && msg.content) {
        msg.expanded = newExpanded;
      }
      // For assistant messages with tool calls
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          tc.expanded = newExpanded;
        }
      }
    }
    
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

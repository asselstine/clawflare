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
  CombinedAutocompleteProvider,
  matchesKey,
  type Component,
  type Focusable,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { AgentClient, ChatResponse, ContextInfo, ToolInfo, ServerInfo } from "./client.js";
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
];

// Helper to create Text with 0 padding
function createText(content: string): Text {
  return new Text(content, 0, 0);
}

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
  private messages: Array<{ role: "user" | "assistant" | "error"; content: string; usage?: { totalTokens: number; input: number; output: number }; expanded?: boolean }> = [];
  private contextId: string = "";
  private sessionName: string = "new";
  private isLoading = false;
  private error: string | null = null;
  private selectedMessageIndex: number = -1;
  private serverInfo: { url: string; provider?: string; model?: string; contextTotal?: number } = { url: "" };
  private lastUsage: { totalTokens: number; messageIndex: number } | null = null;
  private abortController: AbortController | null = null;
  private skills: AgentSkill[] = [];
  private skillsPrompt = "";

  // Estimate tokens using Pi's approach: chars/4 (conservative overestimate)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // Calculate context usage like Pi does:
  // Take last known usage + estimate tokens for messages after that
  private getContextUsage(): { tokens: number; contextWindow: number; percent: number } {
    const contextWindow = this.serverInfo.contextTotal || 128000; // Default to 128k if unknown
    
    if (!this.lastUsage) {
      // No usage yet - estimate all messages
      const tokens = this.messages.reduce((sum, msg) => 
        sum + this.estimateTokens(msg.content), 0);
      const percent = (tokens / contextWindow) * 100;
      return { tokens, contextWindow, percent };
    }
    
    // Start with last known usage
    let tokens = this.lastUsage.totalTokens;
    
    // Add estimates for messages after the last usage point
    for (let i = this.lastUsage.messageIndex + 1; i < this.messages.length; i++) {
      tokens += this.estimateTokens(this.messages[i].content);
    }
    
    const percent = (tokens / contextWindow) * 100;
    return { tokens, contextWindow, percent };
  }
  
  // Render interval for async updates
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

    // Editor for input - single line mode (multiline=false by default)
    this.editor = new Editor(this.tui, editorTheme, {
      paddingX: 1,
    });

    // Set up autocomplete with slash commands
    const autocomplete = new CombinedAutocompleteProvider(slashCommands, process.cwd());
    this.editor.setAutocompleteProvider(autocomplete);

    // Handle submissions
    this.editor.onSubmit = (value: string) => this.handleSubmit(value);

    // Add Ctrl+C handler
    this.tui.addInputListener((data: string) => {
      if (matchesKey(data, "ctrl+c")) {
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
      if (matchesKey(data, "up")) {
        this.selectPreviousMessage();
        return { consume: true };
      }
      if (matchesKey(data, "down")) {
        this.selectNextMessage();
        return { consume: true };
      }
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

      // Fetch server info (provider, model, context window)
      const serverInfo = await this.client.getServerInfo();
      this.serverInfo.provider = serverInfo.provider;
      this.serverInfo.model = serverInfo.model;
      this.serverInfo.contextTotal = serverInfo.contextWindow;
      
      // Create a new context instead of loading existing one
      const ctx = await this.client.createContext();
      this.contextId = ctx.id;
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
  private extractContent(content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text)
        .join("");
    }
    return String(content);
  }

  private updateHeader(): void {
    const title = "Clawflare AI Chat";
    const contextInfo = this.contextId ? ` [${this.contextId.slice(0, 8)}] ` : "";
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
      const prefix = msg.role === "user" ? "❱ " : msg.role === "assistant" ? "🤖 " : "⚠ ";
      const colorFn =
        msg.role === "user" ? theme.user : msg.role === "assistant" ? theme.assistant : theme.error;

      // Show full content if selected+expanded, otherwise truncate
      let displayContent = msg.content;
      const maxLen = 500;
      const wasTruncated = displayContent.length > maxLen;
      const isExpanded = isSelected && msg.expanded;
      
      if (wasTruncated && !isExpanded) {
        displayContent = displayContent.substring(0, maxLen) + "\n" + theme.dim("(truncated, press Ctrl+O to expand)");
      }

      // Add selection indicator if selected
      const indicator = isSelected ? theme.accent("▶ ") : "  ";

      // Use full-width block with background for user messages, plain text for others
      if (msg.role === "user") {
        this.messageContainer.addChild(createUserBlock(colorFn(indicator + prefix + displayContent)));
      } else {
        this.messageContainer.addChild(createText(colorFn(indicator + prefix + displayContent)));
      }
    }

    // Show loading if needed
    if (this.isLoading) {
      this.messageContainer.addChild(createText(""));
      this.messageContainer.addChild(createText(theme.dim(" Working... ")));
    }

    // Show error if any
    if (this.error) {
      this.messageContainer.addChild(createText(""));
      this.messageContainer.addChild(createText(theme.error(` Error: ${this.error} `)));
    }

    this.messageContainer.invalidate();
  }

  private setStatus(statusText: string, color: "green" | "yellow" | "red" | "gray" | "blue" = "gray"): void {
    const colorFn = {
      green: chalk.green,
      yellow: chalk.yellow,
      red: chalk.red,
      gray: chalk.gray,
      blue: chalk.blue,
    }[color];

    // Get context usage
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { contextWindow, percent } = this.getContextUsage();
    const contextDisplay = `${percent.toFixed(1)}%/${Math.round(contextWindow / 1000)}k`;
    
    // Right side content: provider ● model
    const providerModel = this.serverInfo.provider && this.serverInfo.model 
      ? `${this.serverInfo.provider} ● ${this.serverInfo.model}` 
      : "";
    
    // Terminal width
    const width = this.terminal.columns;
    const bigDot = "●";
    
    // Build 2 lines of the status bar
    // Line 1: session name ● endpoint  [right]  provider ● model
    // Line 2: status ● context% (status is colored, rest is dim gray)
    
    // Line 1: all dim gray
    const left1 = chalk.gray(`${this.sessionName} ${bigDot} ${this.serverInfo.url || "unknown"}`);
    const right1 = providerModel ? chalk.gray(providerModel) : "";
    const line1 = this.formatStatusLine(left1, right1, width);
    
    // Line 2: status is colored, context% is dim gray
    const left2 = `${colorFn(statusText)} ${chalk.gray(bigDot)} ${chalk.gray(contextDisplay)}`;
    const right2 = "";
    const line2 = this.formatStatusLine(left2, right2, width);
    
    // Combine both lines with newlines, applying the theme
    const fullStatus = `${line1}\n${line2}`;
    this.statusBar.setText(theme.statusBar(fullStatus));
  }

  // Format a line with left and right content, filling the middle with spaces
  // width: total terminal width (the theme.statusBar adds its own padding, so we account for that)
  private formatStatusLine(left: string, right: string, width: number): string {
    // theme.statusBar adds " " on each side, so we have width-2 of actual content
    const contentWidth = Math.max(1, width - 2);
    const leftVisible = this.visibleWidthAnsi(left);
    const rightVisible = this.visibleWidthAnsi(right);
    
    if (rightVisible === 0) {
      // No right content, just left
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

    // Add to history (only if the user actually submitted something - this
    // allows up/down arrows to navigate through sent messages when the
    // editor is empty or when the user edits something new)
    (this.editor as unknown as { addToHistory(text: string): void }).addToHistory(trimmed);

    // Handle slash commands (fire and forget)
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(" ");
      const command = parts[0];
      const args = parts.slice(1).join(" ");
      this.handleSlashCommand(command, args);
      return;
    }

    this.sendPrompt(trimmed, this.withSkillsSummary(trimmed));
  }

  private sendPrompt(displayContent: string, actualContent: string): void {
    // Don't allow new messages while loading
    if (this.isLoading) return;

    // Clear editor
    this.editor.setText("");

    // Add user message. For expanded skills, displayContent intentionally hides full SKILL.md content.
    this.messages.push({ role: "user", content: displayContent });
    this.isLoading = true;
    this.error = null;
    this.renderMessages();
    this.setStatus("Thinking... (Esc to abort)", "yellow");

    // Create abort controller for this request
    this.abortController = new AbortController();
    const requestAbortController = this.abortController;

    // Fire off the chat request with abort support
    this.client.chat(
      { type: "prompt", content: actualContent, contextId: this.contextId },
      requestAbortController.signal
    ).then((response) => {
      // Track usage for context calculation
      const assistantMessageIndex = this.messages.length;
      if (response.type === "error") {
        this.messages.push({ role: "error", content: response.content });
      } else {
        this.messages.push({ role: "assistant", content: response.content });
        // If response has usage info, track it
        // Note: For now we estimate since response doesn't include usage
        // In future, response should include usage from the agent
        if (response.contextId) {
          this.contextId = response.contextId;
          this.updateHeader();
        }
      }
      // Mark this as the last known usage point (estimate for now)
      const totalContent = this.messages.map(m => m.content).join("");
      this.lastUsage = {
        totalTokens: this.estimateTokens(totalContent),
        messageIndex: assistantMessageIndex
      };
    }).catch((e) => {
      if (e instanceof Error && e.name === "AbortError" && requestAbortController.signal.aborted) {
        // Request was aborted by the user - already handled in abortCurrentOperation.
        return;
      }
      this.error = e instanceof Error ? e.message : "Unknown error";
      this.messages.push({ role: "error", content: this.error });
    }).finally(() => {
      this.isLoading = false;
      this.abortController = null;
      this.renderMessages();
      // Only show Ready if there was no error and the user did not abort.
      if (this.error) {
        this.setStatus("Error", "red");
      } else if (requestAbortController.signal.aborted) {
        this.setStatus("Aborted", "yellow");
      } else {
        this.setStatus("Ready", "green");
      }
    });
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
      this.renderMessages();
      this.setStatus("Aborted", "yellow");
    }
  }

  private toggleExpandSelectedMessage(): void {
    // If no message selected, select the last one
    if (this.selectedMessageIndex < 0 && this.messages.length > 0) {
      this.selectedMessageIndex = this.messages.length - 1;
      // Don't expand - just select so user can see what's selected
    } else if (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.messages.length) {
      // Toggle expansion
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

    // Fire and forget - use void to suppress unhandled promise warning
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
            this.contextId = ctx.id;
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
            this.contextId = ctx.id;
            this.messages = ctx.messages.map((m) => ({
              role: m.role as "user" | "assistant" | "error",
              content: this.extractContent(m.content),
            }));
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
/clear - Clear chat history
/exit - Exit the CLI
/help - Show this help message

Shortcuts:
Ctrl+C - Quit
Esc - Abort current operation
↑/↓ - Select message
Ctrl+O - Expand/collapse selected message`,
          });
          this.renderMessages();
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
    }, 100); // 100ms refresh
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

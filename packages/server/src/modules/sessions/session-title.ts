const MAX_TITLE_LENGTH = 60;

const LEADING_CONNECTOR_PATTERN =
  /^(?:please|can you|could you|would you|will you|i need you to|i want you to|help me|hey|hi|hello)\b[\s,.:;-]*/i;

const CONNECTOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "please",
  "the",
  "to",
  "with",
]);

export function createSessionTitleFromPrompt(prompt: string): string | undefined {
  const firstSentence = extractFirstSentence(prompt);
  if (!firstSentence) return undefined;

  const withoutLeadingConnectors = removeLeadingConnectors(firstSentence);
  const title = removeConnectorWords(withoutLeadingConnectors || firstSentence);
  const clipped = clipTitle(title || firstSentence, MAX_TITLE_LENGTH);

  return clipped || undefined;
}

function removeLeadingConnectors(text: string): string {
  let current = text.trim();

  for (let i = 0; i < 3; i++) {
    const next = current.replace(LEADING_CONNECTOR_PATTERN, "").trim();
    if (next === current) break;
    current = next;
  }

  return current;
}

function extractFirstSentence(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? normalized).replace(/[.!?]+$/, "").trim();
}

function removeConnectorWords(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => !CONNECTOR_WORDS.has(word.replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase()))
    .join(" ")
    .trim();
}

function clipTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;

  const clipped = title.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  return clipped || title.slice(0, maxLength).trim();
}

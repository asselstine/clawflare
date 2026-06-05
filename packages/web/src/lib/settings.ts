import { z } from "zod";

const defaultServerUrl = "https://clawflare-runtime.brendan-410.workers.dev";

const settingsSchema = z.object({
  serverUrl: z.string().url().default(defaultServerUrl),
  token: z.string().default(""),
});

export type AppSettings = z.infer<typeof settingsSchema>;

const key = "clawflare.web.settings";

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(key);
  if (!raw) return settingsSchema.parse({});

  try {
    const settings = settingsSchema.parse(JSON.parse(raw));
    if (!settings.token && settings.serverUrl === "https://clawflare.com") {
      return { ...settings, serverUrl: defaultServerUrl };
    }
    return settings;
  } catch {
    return settingsSchema.parse({});
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(key, JSON.stringify(settingsSchema.parse(settings)));
}

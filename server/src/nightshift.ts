// Meterless Nightshift client. Nightshift exposes an OpenAI-compatible runtime on the
// local network; model ids are routing modes (meterless/deep, meterless/fast) and the
// runtime reports which model actually served each request, which we log.
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.ts";

export interface ChatResult { text: string; model: string; route: string; ms: number; usage?: { prompt_tokens?: number; completion_tokens?: number } }

export function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "").replace(/\/(v1\/)?(chat\/completions|models|healthz)$/, "").replace(/\/v1$/, "");
  return `${u}/v1`;
}

function token(): string {
  if (config.nightshift.token) return config.nightshift.token;
  if (config.nightshift.tokenFile && existsSync(config.nightshift.tokenFile)) return readFileSync(config.nightshift.tokenFile, "utf8").trim();
  return "";
}

export class Nightshift {
  readonly base = normalizeBaseUrl(config.nightshift.baseUrl);

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      "meterless-app": config.nightshift.app,
      "meterless-scope": "user",
    };
  }

  // /v1/models decides status: 401/403 is "unauthorized", 200 with meterless ids is "online".
  async status(): Promise<{ state: "online" | "unauthorized" | "offline"; models: string[] }> {
    try {
      const r = await fetch(`${this.base}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (r.status === 401 || r.status === 403) return { state: "unauthorized", models: [] };
      if (!r.ok) return { state: "offline", models: [] };
      const body = (await r.json()) as { data?: { id: string }[] };
      const models = (body.data ?? []).map((m) => m.id);
      return { state: models.length ? "online" : "offline", models };
    } catch {
      return { state: "offline", models: [] };
    }
  }

  async chat(route: string, messages: { role: "system" | "user" | "assistant"; content: string }[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<ChatResult> {
    const t0 = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${this.base}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          signal: AbortSignal.timeout(config.nightshift.timeoutMs),
          body: JSON.stringify({ model: route, messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 1200 }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`Nightshift HTTP ${r.status}`);
        if (!r.ok) throw Object.assign(new Error(`Nightshift HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { fatal: true });
        const body: any = await r.json();
        const served = body.model ?? r.headers.get("x-meterless-model") ?? r.headers.get("meterless-model") ?? route;
        return { text: body.choices?.[0]?.message?.content ?? "", model: served, route, ms: Date.now() - t0, usage: body.usage };
      } catch (err) {
        lastErr = err;
        if ((err as any).fatal) break;
        await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in model output");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unbalanced JSON in model output");
}

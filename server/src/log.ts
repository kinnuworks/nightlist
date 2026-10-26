// Run traces: one JSON line per agent action, written to stdout and logs/<run>.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOGS } from "./config.ts";

export interface TraceEvent {
  agent: string;
  action: string;
  status: "ok" | "retry" | "blocked" | "failed" | "info" | "revise";
  summary: string;
  target?: string;
  model?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export class Trace {
  readonly runId: string;
  readonly file: string;
  private quiet: boolean;
  readonly events: (TraceEvent & { ts: string; runId: string; seq: number })[] = [];

  constructor(runId: string, opts: { quiet?: boolean; dir?: string } = {}) {
    this.runId = runId;
    const dir = opts.dir ?? LOGS;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${runId}.jsonl`);
    this.quiet = Boolean(opts.quiet);
  }

  emit(e: TraceEvent) {
    const line = { ts: new Date().toISOString(), runId: this.runId, seq: this.events.length + 1, ...e };
    this.events.push(line);
    appendFileSync(this.file, JSON.stringify(line) + "\n");
    if (!this.quiet) {
      const model = e.model ? ` [${e.model}]` : "";
      const to = e.target ? ` -> ${e.target}` : "";
      console.log(`${line.ts.slice(11, 19)} ${e.agent.padEnd(10)} ${e.action.padEnd(22)} ${e.status.padEnd(7)}${model}${to} ${e.summary}`);
    }
  }

  async time<T>(base: Omit<TraceEvent, "durationMs" | "status"> & { status?: TraceEvent["status"] }, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.emit({ ...base, status: base.status ?? "ok", durationMs: Date.now() - t0 });
      return out;
    } catch (err) {
      this.emit({ ...base, status: "failed", durationMs: Date.now() - t0, summary: `${base.summary}: ${(err as Error).message}` });
      throw err;
    }
  }
}

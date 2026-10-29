/**
 * The files backend: a folder in any repo. `runs/<run>/<writer>.jsonl`, one file per run per
 * writer, so two sessions on one run never touch the same file and git merges clean. A trace is
 * the union of a run's files in time order. Plan files sit beside the runs,
 * `plans/<kind>.json`. DuckDB reads the JSONL as it is.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AskKind, PlanFile } from "../plan/index.js";
import { type Filter, type Ledger, matches, type YieldFilter, yieldRows } from "./ledger.js";
import { byTime, LedgerRecord } from "./records.js";

/** A line the backend could not read: a partial last line from a killed writer, or a record it does not know. */
export interface Problem {
  file: string;
  line: number;
  why: string;
}

const safe = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-");

const exists = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
};

export class FilesLedger implements Ledger {
  /** Lines skipped on read, since this ledger was made. Report them; never throw on them. */
  readonly problems: Problem[] = [];

  /** `writer` names this session's file: a person's name, a session id. `by` on a record stays data. */
  constructor(
    readonly root: string,
    readonly writer: string,
  ) {}

  runDir(run: string): string {
    return join(this.root, "runs", safe(run));
  }

  file(run: string): string {
    return join(this.runDir(run), `${safe(this.writer)}.jsonl`);
  }

  async append(record: LedgerRecord): Promise<void> {
    await mkdir(this.runDir(record.run), { recursive: true });
    await appendFile(this.file(record.run), `${JSON.stringify(record)}\n`, "utf8");
  }

  /** The runs on disk, by name. */
  async runs(): Promise<string[]> {
    return (await exists(join(this.root, "runs"))).sort();
  }

  private async readFile(path: string): Promise<LedgerRecord[]> {
    const out: LedgerRecord[] = [];
    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    const complete = text.endsWith("\n") ? lines.length - 1 : lines.length - 1;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      if (i >= complete) {
        this.problems.push({ file: path, line: i + 1, why: "partial last line" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.problems.push({ file: path, line: i + 1, why: "not JSON" });
        return;
      }
      const r = LedgerRecord.safeParse(parsed);
      if (r.success) out.push(r.data);
      else
        this.problems.push({ file: path, line: i + 1, why: r.error.issues[0]?.message ?? "bad" });
    });
    return out;
  }

  async trace(run: string): Promise<LedgerRecord[]> {
    const dir = this.runDir(run);
    const files = (await exists(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    const parts = await Promise.all(files.map((f) => this.readFile(join(dir, f))));
    return parts.flat().sort(byTime);
  }

  async scan(filter: Filter = {}): Promise<LedgerRecord[]> {
    const runs = filter.run !== undefined ? [filter.run] : await this.runs();
    const parts = await Promise.all(runs.map((r) => this.trace(r)));
    return parts
      .flat()
      .filter((r) => matches(r, filter))
      .sort(byTime);
  }

  async yield(filter: YieldFilter = {}) {
    return yieldRows(await this.scan(), filter);
  }

  planPath(kind: AskKind): string {
    return join(this.root, "plans", `${kind}.json`);
  }

  /** The tuned plan file for a kind, or null when the ledger has none (the stock plan file applies). */
  async readPlan(kind: AskKind): Promise<PlanFile | null> {
    try {
      return PlanFile.parse(JSON.parse(await readFile(this.planPath(kind), "utf8")));
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }

  async writePlan(planFile: PlanFile): Promise<string> {
    const path = this.planPath(planFile.kind);
    await mkdir(join(this.root, "plans"), { recursive: true });
    await writeFile(path, `${JSON.stringify(planFile, null, 2)}\n`, "utf8");
    return path;
  }
}

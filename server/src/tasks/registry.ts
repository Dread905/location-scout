/**
 * The background jobs this app runs, in one place. Ported from event-scout's
 * tasks/registry.ts — a task is a name, a schedule, a way to tell whether it
 * is switched on, and something to run; the registry adds a lock, a bounded
 * log, last-run/last-result in kv, and a derived next-due.
 */

export interface TaskResult {
  ok: boolean;
  message: string;
}

export type TaskLog = (msg: string) => void;

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface TaskDef {
  name: string;
  label: string;
  description: string;
  schedule?: string;
  intervalMinutes?: () => number;
  enabled: () => boolean;
  setEnabled?: (on: boolean) => void;
  lockGroup?: string;
  run: (log: TaskLog) => Promise<TaskResult>;
}

export interface TaskStatus {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  canDisable: boolean;
  manualOnly: boolean;
  running: boolean;
  blockedBy: string | null;
  schedule: string | null;
  intervalMinutes: number | null;
  lastRun: string | null;
  lastResult: string | null;
  lastOk: boolean | null;
  nextDue: string | null;
  log: string[];
}

const MAX_LOG_LINES = 200;
const MAX_HISTORY = 500;

export interface LogEntry {
  seq: number;
  at: string;
  task: string;
  kind: 'start' | 'log' | 'end';
  line: string;
  failed?: boolean;
}

export function nextDueFrom(lastRun: string | null, intervalMinutes: number | null): string | null {
  if (!lastRun || intervalMinutes == null) return null;
  const at = Date.parse(lastRun);
  if (!Number.isFinite(at)) return null;
  return new Date(at + intervalMinutes * 60_000).toISOString();
}

export function isDue(lastRun: string | null, intervalMinutes: number | null, now = Date.now()): boolean {
  if (intervalMinutes == null) return true;
  if (!lastRun) return true;
  const at = Date.parse(lastRun);
  if (!Number.isFinite(at)) return true;
  return now - at >= intervalMinutes * 60_000;
}

export function createRegistry(store: KvStore) {
  const defs = new Map<string, TaskDef>();
  const logs = new Map<string, string[]>();
  const history: LogEntry[] = [];
  let seq = 0;

  function remember(task: string, kind: LogEntry['kind'], line: string, failed?: boolean): void {
    history.push({ seq: ++seq, at: new Date().toISOString(), task, kind, line, ...(failed ? { failed } : {}) });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  }

  function since(from = 0): { entries: LogEntry[]; seq: number } {
    return { entries: from <= 0 ? [...history] : history.filter((e) => e.seq > from), seq };
  }

  const held = new Map<string, string>();
  const groupOf = (def: TaskDef): string => def.lockGroup ?? def.name;
  const key = (name: string, field: string): string => `task:${name}:${field}`;

  function record(name: string, result: TaskResult): void {
    store.set(key(name, 'lastRun'), new Date().toISOString());
    store.set(key(name, 'lastResult'), result.message);
    store.set(key(name, 'lastOk'), result.ok ? '1' : '0');
  }

  function register(def: TaskDef): void {
    defs.set(def.name, def);
  }

  function list(): TaskDef[] {
    return [...defs.values()];
  }

  function status(name: string): TaskStatus | null {
    const def = defs.get(name);
    if (!def) return null;
    const lastRun = store.get(key(name, 'lastRun'));
    const lastOk = store.get(key(name, 'lastOk'));
    const interval = def.intervalMinutes ? def.intervalMinutes() : null;
    const holder = held.get(groupOf(def)) ?? null;
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      enabled: def.enabled(),
      canDisable: Boolean(def.setEnabled),
      manualOnly: !def.schedule,
      running: holder === name,
      blockedBy: holder && holder !== name ? (defs.get(holder)?.label ?? holder) : null,
      schedule: def.schedule ?? null,
      intervalMinutes: interval,
      lastRun,
      lastResult: store.get(key(name, 'lastResult')),
      lastOk: lastOk == null ? null : lastOk === '1',
      nextDue: def.schedule ? nextDueFrom(lastRun, interval) : null,
      log: logs.get(name) ?? [],
    };
  }

  function statuses(): TaskStatus[] {
    return list().map((d) => status(d.name)!);
  }

  function isRunning(name: string): boolean {
    const def = defs.get(name);
    return def ? held.get(groupOf(def)) === name : false;
  }

  async function run(name: string, opts: { force?: boolean } = {}): Promise<TaskResult> {
    const def = defs.get(name);
    if (!def) return { ok: false, message: `Unknown task: ${name}` };

    const group = groupOf(def);
    const holder = held.get(group);
    if (holder) {
      return {
        ok: false,
        message:
          holder === name
            ? `${def.label} is already running`
            : `${defs.get(holder)?.label ?? holder} is running and shares the same lock`,
      };
    }
    if (!opts.force && !def.enabled()) return { ok: false, message: `${def.label} is switched off` };

    held.set(group, name);
    const lines: string[] = [];
    const log: TaskLog = (msg) => {
      lines.push(msg);
      if (lines.length > MAX_LOG_LINES) lines.shift();
      remember(name, 'log', msg);
    };
    remember(name, 'start', `${def.label} started`);

    try {
      const result = await def.run(log);
      logs.set(name, lines);
      record(name, result);
      remember(name, 'end', result.message, !result.ok);
      return result;
    } catch (err) {
      const message = (err as Error).message;
      logs.set(name, [...lines, `failed: ${message}`].slice(-MAX_LOG_LINES));
      record(name, { ok: false, message: `failed: ${message}` });
      remember(name, 'end', `failed: ${message}`, true);
      return { ok: false, message };
    } finally {
      held.delete(group);
    }
  }

  async function runIfDue(name: string): Promise<TaskResult | null> {
    const def = defs.get(name);
    if (!def || !def.enabled()) return null;
    if (held.has(groupOf(def))) return null;
    const interval = def.intervalMinutes ? def.intervalMinutes() : null;
    if (!isDue(store.get(key(name, 'lastRun')), interval)) return null;
    return run(name);
  }

  function setEnabled(name: string, on: boolean): TaskResult {
    const def = defs.get(name);
    if (!def) return { ok: false, message: `Unknown task: ${name}` };
    if (!def.setEnabled) return { ok: false, message: `${def.label} cannot be switched off` };
    def.setEnabled(on);
    return { ok: true, message: `${def.label} ${on ? 'enabled' : 'disabled'}` };
  }

  return { register, list, run, runIfDue, isRunning, status, statuses, setEnabled, since };
}

export type TaskRegistry = ReturnType<typeof createRegistry>;

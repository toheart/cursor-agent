import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable, Writable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { RunOptions } from "./types.js";

/**
 * Runner test harness.
 * Follows the OpenClaw test-harness pattern with centralized mocks and utilities.
 */

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./process-registry.js", () => ({
  isFull: vi.fn(() => false),
  register: vi.fn(),
  unregister: vi.fn(),
  getActiveCount: vi.fn(() => 0),
  killWithGrace: vi.fn(),
}));

import { runCursorAgent } from "./runner.js";
import * as registry from "./process-registry.js";

function createMockChildProcess(): ChildProcess & { _stdout: PassThrough; simulateOutput: (lines: string[]) => void; simulateClose: (code: number) => void; simulateError: (msg: string) => void } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const proc = Object.assign(emitter, {
    pid: 12345,
    exitCode: null as number | null,
    killed: false,
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    stdout,
    stderr,
    stdio: [null, stdout, stderr] as any,
    connected: false,
    kill: vi.fn(),
    disconnect: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    _stdout: stdout,
    simulateOutput(lines: string[]) {
      for (const line of lines) {
        stdout.write(line + "\n");
      }
    },
    simulateClose(code: number) {
      proc.exitCode = code;
      stdout.end();
      stderr.end();
      setTimeout(() => emitter.emit("close", code, null), 10);
    },
    simulateError(msg: string) {
      emitter.emit("error", new Error(msg));
    },
  }) as any;

  return proc;
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    agentPath: "/usr/local/bin/agent",
    projectPath: "/tmp/test-project",
    prompt: "analyze the code",
    mode: "ask",
    timeoutSec: 60,
    noOutputTimeoutSec: 30,
    enableMcp: true,
    ...overrides,
  };
}

/** Generate a stream-json formatted event line */
function jsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("runCursorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(registry.isFull).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error immediately when concurrency is full", async () => {
    vi.mocked(registry.isFull).mockReturnValue(true);
    vi.mocked(registry.getActiveCount).mockReturnValue(3);

    const result = await runCursorAgent(makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toBe("max concurrency reached");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("collects the full event stream successfully", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());

    proc.simulateOutput([
      jsonLine({ type: "system", subtype: "init", session_id: "sess-123", model: "claude-4", cwd: "/tmp", timestamp_ms: 1 }),
      jsonLine({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] }, timestamp_ms: 2 }),
      jsonLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Analysis completed" }] }, timestamp_ms: 3 }),
      jsonLine({ type: "result", subtype: "success", result: "done", duration_ms: 1000, is_error: false, usage: { inputTokens: 100, outputTokens: 50 }, timestamp_ms: 4 }),
    ]);
    proc.simulateClose(0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-123");
    expect(result.resultText).toBe("done");
    expect(result.events).toHaveLength(3);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("collects tool_call events and counts them", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());

    proc.simulateOutput([
      jsonLine({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { readToolCall: { args: { path: "/tmp/a.ts" } } }, timestamp_ms: 1 }),
      jsonLine({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { readToolCall: { result: "content" } }, timestamp_ms: 2 }),
      jsonLine({ type: "tool_call", subtype: "started", call_id: "c2", tool_call: { editToolCall: { args: { path: "/tmp/b.ts" } } }, timestamp_ms: 3 }),
      jsonLine({ type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { editToolCall: { result: "ok" } }, timestamp_ms: 4 }),
      jsonLine({ type: "result", subtype: "success", result: "done", duration_ms: 500, is_error: false, timestamp_ms: 5 }),
    ]);
    proc.simulateClose(0);

    const result = await promise;
    expect(result.toolCallCount).toBe(2);
    expect(result.events.filter(e => e.type === "tool_start")).toHaveLength(2);
    expect(result.events.filter(e => e.type === "tool_end")).toHaveLength(2);
  });

  it("returns error when process spawn fails", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());
    proc.simulateError("spawn ENOENT");

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("spawn ENOENT");
  });

  it("terminates process on AbortSignal", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);
    const ac = new AbortController();

    const promise = runCursorAgent(makeOpts({ signal: ac.signal }));

    ac.abort();
    proc.simulateClose(1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
  });

  it("registers and unregisters with registry", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ runId: "test-run-1" }));

    proc.simulateOutput([
      jsonLine({ type: "result", subtype: "success", result: "ok", duration_ms: 100, is_error: false, timestamp_ms: 1 }),
    ]);
    proc.simulateClose(0);

    await promise;
    expect(registry.register).toHaveBeenCalledWith("test-run-1", expect.objectContaining({ projectPath: "/tmp/test-project" }));
    expect(registry.unregister).toHaveBeenCalledWith("test-run-1");
  });

  it("skips invalid JSON lines and continues processing", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());

    proc.simulateOutput([
      "some random log output",
      "",
      jsonLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, timestamp_ms: 1 }),
      "another invalid line",
      jsonLine({ type: "result", subtype: "success", result: "done", duration_ms: 100, is_error: false, timestamp_ms: 2 }),
    ]);
    proc.simulateClose(0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);
  });

  it("builds command args for ask mode", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ mode: "ask" }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--mode");
    expect(args).toContain("ask");
  });

  it("does not pass --mode for agent mode", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ mode: "agent" }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mode");
  });

  it("passes --approve-mcps when enableMcp is true", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ enableMcp: true }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--approve-mcps");
    expect(args).toContain("--force");
  });

  it("includes --model when model is specified", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ model: "claude-4-sonnet" }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("claude-4-sonnet");
  });

  it("--continue flag", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ continueSession: true }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--continue");
  });

  it("--resume flag", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts({ resumeSessionId: "chat-abc" }));
    proc.simulateClose(0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("chat-abc");
  });

  it("sets cwd on all platforms", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());
    proc.simulateClose(0);
    await promise;

    const spawnOpts = spawnMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(spawnOpts.cwd).toBe("/tmp/test-project");
  });

  it("enables detached mode on Unix", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCursorAgent(makeOpts());
    proc.simulateClose(0);
    await promise;

    if (process.platform !== "win32") {
      const spawnOpts = spawnMock.mock.calls[0]![2] as Record<string, unknown>;
      expect(spawnOpts.detached).toBe(true);
      expect(proc.unref).toHaveBeenCalled();
    }
  });
});

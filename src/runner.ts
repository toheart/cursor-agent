import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseStreamLine, extractToolName, extractToolArgs, extractToolResult } from "./parser.js";
import * as registry from "./process-registry.js";
import type {
  RunOptions,
  RunResult,
  AssistantEvent,
  ResultEvent,
  ToolCallEvent,
  SystemInitEvent,
  CollectedEvent,
} from "./types.js";

/** Build CLI command and arguments (跨平台统一) */
function buildCommand(opts: RunOptions): { cmd: string; args: string[]; shell: boolean } {
  const resolved = opts.resolvedBinary;

  const cliArgs: string[] = [];

  if (resolved) {
    // 直接调用 node，entryScript 作为第一个参数
    cliArgs.push(resolved.entryScript);
  }

  cliArgs.push(
    ...(opts.prefixArgs ?? []),
    "-p", "--trust",
    "--output-format", "stream-json",
  );

  if (opts.resumeSessionId) {
    cliArgs.push("--resume", opts.resumeSessionId);
  } else if (opts.continueSession) {
    cliArgs.push("--continue");
  } else if (opts.mode !== "agent") {
    cliArgs.push("--mode", opts.mode);
  }

  if (opts.enableMcp) {
    cliArgs.push("--approve-mcps", "--force");
  }
  if (opts.model) {
    cliArgs.push("--model", opts.model);
  }

  cliArgs.push(opts.prompt);

  if (resolved) {
    // 直接调用 node 可执行文件，不需要 shell
    return { cmd: resolved.nodeBin, args: cliArgs, shell: false };
  }

  // 回退：直接调用 agentPath（兼容未来独立 agent.exe 等场景）
  const needsShell =
    process.platform === "win32" &&
    /\.(cmd|bat)$/i.test(opts.agentPath);

  return { cmd: opts.agentPath, args: cliArgs, shell: needsShell };
}

/** Execute Cursor Agent CLI and collect the full event stream */
export async function runCursorAgent(opts: RunOptions): Promise<RunResult> {
  if (registry.isFull()) {
    return {
      success: false,
      resultText: `Concurrency limit reached (${registry.getActiveCount()}), please try again later`,
      durationMs: 0,
      toolCallCount: 0,
      error: "max concurrency reached",
      events: [],
    };
  }

  const runId = opts.runId ?? randomUUID();
  const startTime = Date.now();
  const { cmd, args, shell } = buildCommand(opts);

  const isUnix = process.platform !== "win32";
  const proc = spawn(cmd, args, {
    cwd: opts.projectPath,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell,
    detached: isUnix,
  });
  if (isUnix) proc.unref();

  registry.register(runId, { proc, projectPath: opts.projectPath, startTime });

  let sessionId: string | undefined;
  let resultText = "";
  let toolCallCount = 0;
  let completed = false;
  let error: string | undefined;
  let usage: ResultEvent["usage"];
  let lastOutputTime = Date.now();
  const events: CollectedEvent[] = [];

  const terminateProcess = () => {
    if (proc.exitCode !== null || proc.killed) return;
    registry.killWithGrace(proc);
  };

  const totalTimeout = setTimeout(() => {
    if (!completed) {
      error = `total timeout (${opts.timeoutSec}s)`;
      terminateProcess();
    }
  }, opts.timeoutSec * 1000);

  const noOutputCheck = setInterval(() => {
    if (Date.now() - lastOutputTime > opts.noOutputTimeoutSec * 1000) {
      if (!completed) {
        error = `no output timeout (${opts.noOutputTimeoutSec}s)`;
        terminateProcess();
      }
    }
  }, 5000);

  const onAbort = () => {
    if (!completed) {
      error = "aborted";
      terminateProcess();
    }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  return new Promise<RunResult>((resolve) => {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on("line", (line) => {
      lastOutputTime = Date.now();
      const event = parseStreamLine(line);
      if (!event) return;

      switch (event.type) {
        case "system":
          if (event.subtype === "init") {
            sessionId = (event as SystemInitEvent).session_id;
          }
          break;

        case "user": {
          const ue = event as { message?: { content?: Array<{ text?: string }> } };
          const text = ue.message?.content?.[0]?.text;
          if (text) {
            events.push({ type: "user", text, timestamp: event.timestamp_ms });
          }
          break;
        }

        case "assistant": {
          const ae = event as AssistantEvent;
          const text = ae.message?.content?.[0]?.text;
          if (text) {
            events.push({ type: "assistant", text, timestamp: event.timestamp_ms });
          }
          break;
        }

        case "tool_call": {
          const tc = event as ToolCallEvent;
          if (tc.subtype === "started") {
            toolCallCount++;
            events.push({
              type: "tool_start",
              toolName: extractToolName(tc),
              toolArgs: extractToolArgs(tc),
              timestamp: event.timestamp_ms,
            });
          } else if (tc.subtype === "completed") {
            events.push({
              type: "tool_end",
              toolName: extractToolName(tc),
              toolResult: extractToolResult(tc),
              timestamp: event.timestamp_ms,
            });
          }
          break;
        }

        case "result": {
          const re = event as ResultEvent;
          resultText = re.result ?? "";
          usage = re.usage;
          completed = true;
          events.push({
            type: "result",
            resultData: re,
            timestamp: event.timestamp_ms,
          });
          break;
        }
      }
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      clearTimeout(totalTimeout);
      clearInterval(noOutputCheck);
      opts.signal?.removeEventListener("abort", onAbort);
      registry.unregister(runId);

      if (proc.exitCode === null && !proc.killed) {
        registry.killWithGrace(proc);
      }

      const durationMs = Date.now() - startTime;

      resolve({
        success: !error && completed,
        resultText: resultText || (error ? `Cursor Agent execution failed: ${error}` : "No analysis result obtained"),
        sessionId,
        durationMs,
        toolCallCount,
        error,
        usage,
        events,
      });
    };

    proc.on("close", cleanup);
    proc.on("error", (err) => {
      error = err.message;
      cleanup();
    });
  });
}

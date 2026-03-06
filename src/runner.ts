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

/** Build CLI command and arguments */
function buildCommand(opts: RunOptions): { cmd: string; args: string[] } {
  const agentArgs: string[] = [
    "-p", "--trust",
    "--output-format", "stream-json",
  ];

  // Session management args are mutually exclusive with --mode: skip mode when resuming
  if (opts.resumeSessionId) {
    agentArgs.push("--resume", opts.resumeSessionId);
  } else if (opts.continueSession) {
    agentArgs.push("--continue");
  } else if (opts.mode !== "agent") {
    // agent is the default mode, no need to pass --mode; CLI only accepts plan and ask
    agentArgs.push("--mode", opts.mode);
  }

  if (opts.enableMcp) {
    agentArgs.push("--approve-mcps", "--force");
  }
  if (opts.model) {
    agentArgs.push("--model", opts.model);
  }

  agentArgs.push(opts.prompt);

  if (process.platform === "win32") {
    const escaped = opts.prompt.replace(/'/g, "''");
    const parts = [
      "agent", "-p", "--trust",
      "--output-format", "stream-json",
    ];
    if (opts.resumeSessionId) {
      parts.push("--resume", `'${opts.resumeSessionId}'`);
    } else if (opts.continueSession) {
      parts.push("--continue");
    } else if (opts.mode !== "agent") {
      parts.push("--mode", opts.mode);
    }
    if (opts.enableMcp) parts.push("--approve-mcps", "--force");
    if (opts.model) parts.push("--model", `'${opts.model}'`);
    parts.push(`'${escaped}'`);

    const psCommand = `Set-Location '${opts.projectPath}'; ${parts.join(" ")}`;
    return { cmd: "powershell.exe", args: ["-NoProfile", "-Command", psCommand] };
  }

  return { cmd: opts.agentPath, args: agentArgs };
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
  const { cmd, args } = buildCommand(opts);

  const isUnix = process.platform !== "win32";
  const proc = spawn(cmd, args, {
    cwd: isUnix ? opts.projectPath : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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

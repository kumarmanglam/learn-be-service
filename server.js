// ============================================================
// Java code execution service.
//
// A single POST /run endpoint compiles and runs a Java snippet in an
// isolated per-request temp directory, then cleans up. Built to run on
// Render's free tier (512MB RAM / 0.1 CPU) inside the Docker image that
// ships a JDK alongside Node (see Dockerfile).
//
// Response shape intentionally mirrors the front-end `RunResult` so the
// Next.js proxy can forward it with minimal mapping.
// ============================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;

// Shared secret — only our Next.js proxy knows it. When set, every /run call
// must send `x-run-secret: <value>`. Leave unset locally to run open.
const RUN_SECRET = process.env.RUN_JAVA_SECRET || "";

// Limits (defense-in-depth on a tiny shared box).
const MAX_CODE_LEN = 20000;
const COMPILE_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 5000;
const MAX_STDOUT = 10000;
const MAX_STDERR = 5000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// ---- Basic per-IP rate limit (in-memory sliding window) ----
// The Next.js proxy is the real gate; this is a cheap backstop against a
// stray loop hammering the box. Ephemeral — fine for a single free instance.
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 8;
const hits = new Map(); // ip -> number[] (timestamps)

function rateLimited(ip, now) {
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

// ---- Health check (used by Render + optional external pinger) ----
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "be-service", uptime: process.uptime() });
});

// ---- Spawn a process with a hard timeout; capture + cap output ----
function runProcess(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, opts);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_STDOUT) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString();
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        stdout: stdout.slice(0, MAX_STDOUT),
        stderr: stderr.slice(0, MAX_STDERR),
      });
    };

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---- POST /run — compile then execute a Java snippet ----
app.post("/run", async (req, res) => {
  const now = Date.now();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  if (RUN_SECRET && req.headers["x-run-secret"] !== RUN_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (rateLimited(String(ip), now)) {
    return res.status(429).json({ error: "too many requests, slow down" });
  }

  const code = req.body && req.body.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    return res.status(400).json({ error: "code (string) is required" });
  }
  if (code.length > MAX_CODE_LEN) {
    return res
      .status(400)
      .json({ error: `code too long (max ${MAX_CODE_LEN} chars)` });
  }

  const dir = path.join(os.tmpdir(), `run-${crypto.randomUUID()}`);

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Main.java"), code, "utf8");

    // 1) Compile.
    const compile = await runProcess(
      "javac",
      ["Main.java"],
      { cwd: dir },
      COMPILE_TIMEOUT_MS
    );
    if (compile.timedOut) {
      return res.json({
        stdout: "",
        stderr: compile.stderr,
        exitCode: null,
        timedOut: true,
        error: "compilation timed out",
      });
    }
    if (compile.exitCode !== 0) {
      // Compile error — surface javac's diagnostics as stderr.
      return res.json({
        stdout: "",
        stderr: compile.stderr || "compilation failed",
        exitCode: compile.exitCode,
        timedOut: false,
      });
    }

    // 2) Run (bounded heap; class name must be `Main`).
    const run = await runProcess(
      "java",
      ["-Xmx128m", "Main"],
      { cwd: dir },
      RUN_TIMEOUT_MS
    );
    return res.json({
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      error: run.timedOut ? "execution timed out" : undefined,
    });
  } catch (e) {
    return res.status(500).json({
      stdout: "",
      stderr: "",
      error: (e && e.message) || "internal error",
    });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`be-service listening on :${PORT}`);
});

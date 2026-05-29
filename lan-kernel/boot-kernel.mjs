#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const EZ_DIR = path.join(ROOT, "EZ-by-zCHG-W-LM-Studio-and-3-LLM-s-in-Council-main");
const CONSCIOUS_DIR = path.join(ROOT, "conscious-128-bit-floor");
const HDGL_DIR = path.join(ROOT, "NGINX-HDGL-0.6-c");

const EZ_A_PORT = parseInt(process.env.EZ_A_PORT || "4111", 10);
const EZ_B_PORT = parseInt(process.env.EZ_B_PORT || "4112", 10);
const COORD_PORT = parseInt(process.env.COORD_PORT || "1618", 10);
const COORD_HOST = process.env.COORD_BIND_HOST || process.env.BIND_HOST || "0.0.0.0";
const LLM_HOST = process.env.LLM_HOST || "127.0.0.1";
const LLM_PORT = parseInt(process.env.LLM_PORT || "1234", 10);
const KERNEL_PORT = parseInt(process.env.KERNEL_PORT || "17800", 10);
const KERNEL_HOST = process.env.KERNEL_HOST || COORD_HOST;

const START_LLM = process.env.START_LLM !== "0";
const START_HDGL = process.env.START_HDGL !== "0";

const LLAMA_SERVER_EXE = process.env.LLAMA_SERVER_EXE || path.join(__dirname, "llama-server.exe");
const MODEL_FILE = process.env.MODEL_FILE || findModelNearBootloader();

const PRIME_UI_EXE = process.platform === "win32"
  ? path.join(CONSCIOUS_DIR, "prime_ui.exe")
  : path.join(CONSCIOUS_DIR, "prime_ui");

const HDGL_BIN_CANDIDATES = process.platform === "win32"
  ? [path.join(HDGL_DIR, "bin", "zchg_daemon.exe")]
  : [path.join(HDGL_DIR, "bin", "zchg_daemon")];

const HDGL_BIN = HDGL_BIN_CANDIDATES.find((p) => fs.existsSync(p));
const children = [];

function findModelNearBootloader() {
  const files = safeList(__dirname);
  const gguf = files.find((f) => f.toLowerCase().endsWith(".gguf"));
  if (gguf) return path.join(__dirname, gguf);
  return "";
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function localIPv4s() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const values of Object.values(nics)) {
    for (const nic of values || []) {
      if (nic && nic.family === "IPv4" && !nic.internal) out.push(nic.address);
    }
  }
  return Array.from(new Set(out));
}

function prefixLog(prefix, color) {
  return (chunk) => {
    const text = chunk.toString().trimEnd();
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      process.stdout.write(`${color}[${prefix}]\x1b[0m ${line}\n`);
    }
  };
}

function spawnTracked(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const color = options.color || "\x1b[36m";
  child.stdout.on("data", prefixLog(name, color));
  child.stderr.on("data", prefixLog(name, "\x1b[31m"));

  child.on("exit", (code, signal) => {
    process.stdout.write(`[${name}] exited code=${code} signal=${signal || "-"}\n`);
  });

  child.on("error", (err) => {
    process.stderr.write(`[${name}] spawn failed: ${err.message}\n`);
  });

  children.push(child);
  return child;
}

function spawnNodeScript(name, scriptName, cwd, env, color) {
  const node = process.execPath;
  return spawnTracked(name, node, [scriptName], { cwd, env, color });
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function startKernelApi() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && u.pathname === "/kernel/status") {
      const [coord, mcpA, mcpB, hdgl] = await Promise.all([
        fetchText(`http://127.0.0.1:${COORD_PORT}/status`),
        fetchText(`http://127.0.0.1:${EZ_A_PORT}/health`),
        fetchText(`http://127.0.0.1:${EZ_B_PORT}/health`),
        fetchText("http://127.0.0.1:8080/health"),
      ]);
      const payload = {
        kernel: "online",
        coord,
        mcpA,
        mcpB,
        hdgl,
        consciousPrimeUiPresent: fs.existsSync(PRIME_UI_EXE),
        modelFile: MODEL_FILE || null,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (req.method === "POST" && u.pathname === "/kernel/prime") {
      if (!fs.existsSync(PRIME_UI_EXE)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "prime_ui executable not found", path: PRIME_UI_EXE }));
        return;
      }

      let body = "";
      req.on("data", (d) => {
        body += d.toString();
        if (body.length > 50000) req.destroy();
      });
      req.on("end", () => {
        let key = "5";
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (parsed.key) key = String(parsed.key);
        } catch {
          // keep default key
        }

        const child = spawn(PRIME_UI_EXE, [key], {
          cwd: CONSCIOUS_DIR,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("close", (code) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code, key, stdout, stderr }));
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(KERNEL_PORT, KERNEL_HOST, () => {
    process.stdout.write(`[KERNEL] API listening on http://${KERNEL_HOST}:${KERNEL_PORT}/kernel/status\n`);
  });

  return server;
}

function startStack() {
  process.stdout.write("\n=== KISS2 LAN Boot Kernel ===\n");
  process.stdout.write(`Root: ${ROOT}\n`);

  ensureEzDependencies();

  if (START_LLM) {
    if (fs.existsSync(LLAMA_SERVER_EXE) && MODEL_FILE && fs.existsSync(MODEL_FILE)) {
      spawnTracked(
        "LLM",
        LLAMA_SERVER_EXE,
        ["-m", MODEL_FILE, "--host", "127.0.0.1", "--port", String(LLM_PORT)],
        { cwd: __dirname, color: "\x1b[35m" }
      );
      process.stdout.write(`[KERNEL] LLM runner launched with model: ${MODEL_FILE}\n`);
    } else {
      process.stdout.write("[KERNEL] LLM auto-launch skipped (missing llama-server.exe or model file).\n");
      process.stdout.write("[KERNEL] Set LLAMA_SERVER_EXE and MODEL_FILE to enable local model boot.\n");
    }
  }

  spawnNodeScript(
    "MCP-A",
    "server.js",
    EZ_DIR,
    { MCP_PORT: String(EZ_A_PORT), MCP_HOST: COORD_HOST },
    "\x1b[36m"
  );

  spawnNodeScript(
    "MCP-B",
    "server-dos.js",
    EZ_DIR,
    { MCP_PORT: String(EZ_B_PORT), MCP_HOST: COORD_HOST },
    "\x1b[33m"
  );

  spawnNodeScript(
    "COORD",
    "coord-proxy.js",
    EZ_DIR,
    {
      COORD_PORT: String(COORD_PORT),
      COORD_BIND_HOST: COORD_HOST,
      LLM_HOST,
      LLM_PORT: String(LLM_PORT),
    },
    "\x1b[34m"
  );

  if (START_HDGL && HDGL_BIN) {
    spawnTracked(
      "HDGL",
      HDGL_BIN,
      [],
      {
        cwd: HDGL_DIR,
        env: {
          LN_LOCAL_NODE: process.env.LN_LOCAL_NODE || "127.0.0.1",
          LN_CLUSTER_SECRET: process.env.LN_CLUSTER_SECRET || "dev-local-secret",
          LN_HTTP_PORT: process.env.LN_HTTP_PORT || "8080",
        },
        color: "\x1b[32m",
      }
    );
  } else {
    process.stdout.write("[KERNEL] HDGL daemon auto-launch skipped (binary not found or disabled).\n");
  }

  const kernelApiServer = startKernelApi();

  const ips = localIPv4s();
  process.stdout.write("\n=== LAN Access URLs ===\n");
  if (ips.length === 0) {
    process.stdout.write(`Chat:   http://localhost:${COORD_PORT}/chat\n`);
  } else {
    for (const ip of ips) {
      process.stdout.write(`Chat:   http://${ip}:${COORD_PORT}/chat\n`);
      process.stdout.write(`Kernel: http://${ip}:${KERNEL_PORT}/kernel/status\n`);
    }
  }
  process.stdout.write("\nPress Ctrl+C to stop all processes.\n\n");

  const shutdown = () => {
    process.stdout.write("\n[KERNEL] Shutting down children...\n");
    for (const c of children) {
      try { c.kill(); } catch {}
    }
    try { kernelApiServer.close(); } catch {}
    setTimeout(() => process.exit(0), 200);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function ensureEzDependencies() {
  const sdkDir = path.join(EZ_DIR, "node_modules", "@modelcontextprotocol", "sdk");
  if (fs.existsSync(sdkDir)) return;

  process.stdout.write("[KERNEL] EZ dependencies missing; running npm install...\n");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["install"], {
    cwd: EZ_DIR,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.stderr.write("[KERNEL] npm install failed in EZ repo. Fix dependencies and re-run.\n");
    process.exit(result.status || 1);
  }
}

startStack();

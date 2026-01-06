#!/usr/bin/env node
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Docker = require("dockerode");
const docker = new Docker();
const os = require("os");
const path = require("path");
const fsPromises = require("fs").promises;
const fs = require('fs');
const { readData, recreateContainer } = require("./handlers/recreateContainer.js");

/* Start FTP server shortly after startup to allow other initialization to complete. */
setTimeout(() => {
  require('./backend/Server/ftp.js').startFtpServer();
}, 1000);

const dataPath = path.join(__dirname, "data.json");
const config = require("./config.json");

if (os.platform() === 'win32') {
  console.warn(
    "⚠️ Talon may cause errors on Windows. Use a Linux host to run containers safely."
  );
}

/* Ensure the data.json file exists; create an empty object file if missing. */
function ensureDataFile() {
  return new Promise((resolve, reject) => {
    fs.access(dataPath, (err) => {
      if (err) {
        fs.writeFile(dataPath, JSON.stringify({}, null, 2), "utf8", (err) => {
          if (err) return reject(err);
          resolve("File created");
        });
      } else {
        resolve("File exists");
      }
    });
  });
}

/* Load data.json into memory and keep `data` up-to-date. */
let data;
(async () => {
  try {
    await ensureDataFile();
    data = await readData();
  } catch (err) {
    console.error('Failed to initialize data.json:', err);
    process.exit(1);
  }
})();

/* Periodically reload data.json from disk if it changed. */
setInterval(async () => {
  try {
    const diskData = await readData();
    if (JSON.stringify(diskData) !== JSON.stringify(data)) {
      data = diskData;
    }
  } catch (err) {
    console.error("reloadData error:", err);
  }
}, 5000);

const app = express();
app.use(express.json());

/* ANSI color helpers for console output. */
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function ansi(tag, color, message) {
  return `${ANSI[color] || ""}[${tag}]${ANSI.reset} ${message}`;
}

// Decode caret-style control sequences (e.g. '^C') into actual control characters.
// '^X' -> single control character (charCode & 0x1F). Leaves other text intact.
function decodeControlSequences(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '^' && i + 1 < s.length) {
      const next = s[i + 1];
      const code = next.charCodeAt(0);
      out += String.fromCharCode(code & 0x1F);
      i++; // skip next char
    } else {
      out += ch;
    }
  }
  return out;
}

/* Check if Docker daemon is available. */
async function isDockerRunning() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/* Verify that the external panel URL is reachable; exit if not. */
async function isPanelRunning(panelUrl) {
  try {
    await fetch(panelUrl, { method: "GET", timeout: 5000 });
    return true;
  } catch (err) {
    console.error("Panel is not reachable. Is the Talorix panel online?");
    process.exit(1);
  }
}

isPanelRunning(config.panel);

/* Middleware: validate API key on all HTTP routes. */
app.use((req, res, next) => {
  if (req.query.key !== config.key) return res.status(401).json({ error: "Invalid key" });
  next();
});

function loadRoutes(dirPath, routePrefix = '/server') {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    if (file === "ftp.js") return; // skip FTP module
    if (stat.isDirectory()) {
      loadRoutes(fullPath, routePrefix);
    } else if (file.endsWith('.js')) {
      import(fullPath).then((module) => {
        if (module.default) {
          app.use(routePrefix, module.default);
        }
      }).catch(err => console.error(`Failed to load ${fullPath}:`, err));
    }
  });
}

loadRoutes(path.join(process.cwd(), 'backend'));

/* Create HTTP and WebSocket servers. */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

/* In-memory maps for connected clients, attached log streams, and stats intervals. */
const clients = new Map();
const logStreams = new Map();
const statsIntervals = new Map();

/* Recursively compute size (bytes) of a folder. Returns 0 for missing folders. */
async function getFolderSize(dir) {
  let total = 0;
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await getFolderSize(full);
      else if (entry.isFile()) total += (await fsPromises.stat(full)).size;
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("getFolderSize error:", err);
  }
  return total;
}

/* Resolve a data.json entry either by full/partial container ID or by idt key. */
function findDataEntryByContainerOridt(containerOridt) {
  const found = Object.entries(data || {}).find(([_, entry]) =>
    entry.containerId && (entry.containerId === containerOridt || entry.containerId.startsWith(containerOridt))
  );

  if (found) return { idt: found[0], entry: found[1] };
  if (data && data[containerOridt]) return { idt: containerOridt, entry: data[containerOridt] };
  return null;
}

/* Return container storage usage in GB (number). */
async function getContainerDiskUsage(containerIdOridt) {
  const resolved = findDataEntryByContainerOridt(containerIdOridt);
  if (!resolved) return 0;
  const { idt } = resolved;
  const dir = path.join(__dirname, "data", idt);
  const bytes = await getFolderSize(dir);
  return bytes / 1e9;
}

/* Send a structured event to a single WebSocket client (JSON payload). */
function sendEvent(ws, event, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ event, payload, ts: new Date().toISOString() }));
  } catch (e) {
    console.error("sendEvent error:", e);
  }
}

/* Broadcast a structured event to all clients attached to an idt or container id. */
function broadcastToContainer(containeridtOrId, event, payload) {
  const recipients = new Set();
  const directSet = clients.get(containeridtOrId);
  if (directSet) for (const ws of directSet) recipients.add(ws);
  const resolved = findDataEntryByContainerOridt(containeridtOrId);
  if (resolved) {
    const resolvedSet = clients.get(resolved.idt);
    if (resolvedSet) for (const ws of resolvedSet) recipients.add(ws);
  }
  for (const ws of recipients) sendEvent(ws, event, payload);
}

/* Add a WebSocket client under a specific idt key. */
function addClientKey(key, ws) {
  const set = clients.get(key) || new Set();
  set.add(ws);
  clients.set(key, set);
}

/* Remove a WebSocket client from all idt maps and perform cleanup if sets become empty. */
function removeClient(ws) {
  for (const [key, set] of clients.entries()) {
    if (set.has(ws)) {
      set.delete(ws);
      if (set.size === 0) {
        clients.delete(key);
        cleanupLogStreamsByKey(key);
        cleanupStatsByKey(key);
      }
    }
  }
}

/* Destroy and remove stored log stream by containerId. */
function cleanupLogStreamsByContainerId(containerId) {
  const entry = logStreams.get(containerId);
  if (!entry) return;
  try { entry.stream.destroy(); } catch (e) { /* ignore destroy errors */ }
  logStreams.delete(containerId);
}

/* Clear and remove stats interval by containerId. */
function cleanupStatsByContainerId(containerId) {
  const entry = statsIntervals.get(containerId);
  if (!entry) return;
  clearInterval(entry.intervalId);
  statsIntervals.delete(containerId);
}

/* Decrement refCounts and cleanup log streams for either a containerId or idt key. */
function cleanupLogStreamsByKey(key) {
  const entry = logStreams.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      try { entry.stream.destroy(); } catch (e) {}
      logStreams.delete(key);
    }
    return;
  }

  const resolved = findDataEntryByContainerOridt(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = logStreams.get(cid);
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        try { e2.stream.destroy(); } catch (e) {}
        logStreams.delete(cid);
      }
    }
  }
}

/* Decrement refCounts and cleanup stats intervals for either a containerId or idt key. */
function cleanupStatsByKey(key) {
  const entry = statsIntervals.get(key);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      clearInterval(entry.intervalId);
      statsIntervals.delete(key);
    }
    return;
  }

  const resolved = findDataEntryByContainerOridt(key);
  if (resolved) {
    const cid = resolved.entry.containerId;
    const e2 = statsIntervals.get(cid);
    if (e2) {
      e2.refCount--;
      if (e2.refCount <= 0) {
        clearInterval(e2.intervalId);
        statsIntervals.delete(cid);
      }
    }
  }
}

/*
 * Attach container logs and broadcast raw log chunks to all clients for the idt.
 * Performs disk quota check before attaching and handles reference counting so multiple
 * clients don't create duplicate streams.
 */
async function streamLogs(ws, container, requestedContainerId) {
  const resolved = findDataEntryByContainerOridt(requestedContainerId);
  const idt = resolved ? resolved.idt : requestedContainerId;
  const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;

  // Use authoritative container object
  container = docker.getContainer(currentContainerId);

  // Disk usage check before attaching logs
  const usage = await getContainerDiskUsage(idt);
  const allowed = resolved && resolved.entry && typeof resolved.entry.disk === "number"
    ? resolved.entry.disk
    : Infinity;

  addClientKey(idt, ws);

  if (usage >= allowed) {
    const info = await container.inspect().catch(() => null);
    if (info && info.State && info.State.Running) {
      try { await container.kill(); } catch (e) { /* ignore */ }
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container stopped."));
    } else {
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container blocked."));
    }
    return;
  }

  // If there's already an active log stream for this container, increment refCount and return
  if (logStreams.has(currentContainerId)) {
    logStreams.get(currentContainerId).refCount++;
    return;
  }

  // Attach to Docker logs and broadcast raw chunks to clients registered under idt
  container.logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err, stream) => {
    if (err) return sendEvent(ws, "error", `Failed to attach logs: ${err.message || err}`);

    logStreams.set(currentContainerId, {
      stream,
      refCount: (clients.get(idt) || new Set()).size,
    });

    const onData = (chunk) => {
      const raw = chunk.toString("utf8");
      const set = clients.get(idt) || new Set();
      for (const client of set) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(raw); } catch (e) { /* ignore per-client send errors */ }
        }
      }
    };

    stream.on("data", onData);

    stream.on("error", (err) => broadcastToContainer(idt, "error", `Log error: ${err.message}`));

    stream.on("end", () => {
      broadcastToContainer(idt, "power", ansi("Node", "gray", "Log stream ended."));
      if (logStreams.has(currentContainerId)) logStreams.delete(currentContainerId);
    });

    if (!logStreams.get(currentContainerId).stopped) logStreams.get(currentContainerId).stopped = true;

    ws.once("close", () => cleanupLogStreamsByKey(idt));
  });
}

/*
 * Periodically fetch non-streaming container stats and broadcast them to connected clients.
 * Uses a single interval per container and reference counting to avoid duplicate intervals.
 */
async function streamStats(ws, container, requestedContainerId) {
  const resolved = findDataEntryByContainerOridt(requestedContainerId);
  const idt = resolved ? resolved.idt : requestedContainerId;
  const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;

  container = docker.getContainer(currentContainerId);

  addClientKey(idt, ws);

  if (statsIntervals.has(currentContainerId)) {
    statsIntervals.get(currentContainerId).refCount++;
    return;
  }

  function formatUptime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  }

  const intervalId = setInterval(async () => {
    const set = clients.get(idt);
    if (!set || set.size === 0) return;

    try {
      const stats = await new Promise((resolve, reject) =>
        container.stats({ stream: false }, (err, s) => (err ? reject(err) : resolve(s)))
      );

      let uptimeSeconds = 0;
      let uptime = "0s";
      try {
        const info = await container.inspect();
        const startedAt = info?.State?.StartedAt;
        if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
          const startedMs = Date.parse(startedAt);
          if (!Number.isNaN(startedMs)) {
            uptimeSeconds = Math.floor((Date.now() - startedMs) / 1000);
            if (uptimeSeconds < 0) uptimeSeconds = 0;
            uptime = formatUptime(uptimeSeconds);
          }
        }
      } catch (inspectErr) {
        /* ignore inspect error */
      }

      broadcastToContainer(idt, "stats", { stats, uptimeSeconds, uptime });
    } catch (err) {
      if (err && err.statusCode === 404) {
        cleanupStatsByContainerId(currentContainerId);
        return;
      }
      broadcastToContainer(idt, "error", `Stats error: ${err.message}`);
    }
  }, 2000);

  statsIntervals.set(currentContainerId, {
    intervalId,
    refCount: (clients.get(idt) || new Set()).size,
  });

  ws.on("close", () => cleanupStatsByKey(idt));
}

/*
 * Execute a single command inside the container (via attach). Prevent execution if disk quota is exceeded.
 */
async function executeCommand(ws, container, command, requestedContainerId) {
  try {
    const resolved = findDataEntryByContainerOridt(requestedContainerId);
    const idt = resolved ? resolved.idt : requestedContainerId;
    const currentContainerId = resolved ? resolved.entry.containerId : requestedContainerId;
    container = docker.getContainer(currentContainerId);

    const usage = await getContainerDiskUsage(idt);
    const allowed = resolved && resolved.entry && typeof resolved.entry.disk === "number" ? resolved.entry.disk : Infinity;

    console.log(`[disk-check] exec for ${currentContainerId} (idt=${idt}): usage=${usage.toFixed(3)}GB allowed=${allowed === Infinity ? "∞" : allowed}`);

    const info = await container.inspect().catch(() => null);
    if (usage >= allowed) {
      if (info && info.State && info.State.Running) {
        try { await container.kill(); } catch (e) { /* ignore */ }
      }
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — commands blocked."));
      return;
    }

    const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
    stream.on("data", (chunk) => sendEvent(ws, "cmd", chunk.toString("utf8")));
    stream.on("error", (err) => sendEvent(ws, "error", `Exec stream error: ${err.message}`));

    if (command === '^C') {
      stream.write('');
      stream.end();
    } else {
      stream.write(command + "\n");
      stream.end();
    }
  } catch (err) {
    sendEvent(ws, "error", `Failed to exec command: ${err.message}`);
  }
}

/*
 * Perform power actions (start/restart/stop) for a container. Handles disk quota checks and
 * recreating the container when starting/restarting.
 */
async function performPower(ws, container, action, requestedContainerId) {
  try {
    const resolved = findDataEntryByContainerOridt(requestedContainerId);
    const idt = resolved ? resolved.idt : requestedContainerId;
    const entry = resolved ? resolved.entry : null;

    if (!entry) return sendEvent(ws, "error", "Data entry not found");

    const currentContainerId = entry.containerId;
    container = docker.getContainer(currentContainerId);

    const usage = await getContainerDiskUsage(idt);
    const allowed = entry?.disk ?? Infinity;

    const info = await container.inspect().catch(() => null);

    if ((action === "start" || action === "restart") && usage >= allowed) {
      broadcastToContainer(idt, "power", ansi("Node", "red", "Server disk exceed — container will not be started."));
      return;
    }

    if (action === "start" || action === "restart") {
      broadcastToContainer(idt, "power", ansi("Node", "yellow", "Pulling the latest docker image..."));

      if (currentContainerId) {
        cleanupLogStreamsByContainerId(currentContainerId);
        cleanupStatsByContainerId(currentContainerId);
      }

      const newContainer = await recreateContainer(idt);

      for (const c of clients.get(idt) || []) {
        streamLogs(c, newContainer, newContainer.id);
      }

      for (const c of clients.get(idt) || []) {
        streamStats(c, newContainer, newContainer.id);
      }

      broadcastToContainer(idt, "power", ansi("Node", "green", "Starting the container."));
    } else if (action === "stop") {
      if (!info?.State?.Running) {
        return sendEvent(ws, "power", ansi("Node", "red", "Container already stopped."));
      }
      const stopCommand = entry.stopCmd.replace(/{{(.*?)}}/g, (_, key) => entry.env[key] ?? `{{${key}}}`);
      await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }, (err, stream) => {
        if (err) return sendEvent(ws, "error", `Failed to attach for stop: ${err.message}`);
        try {
          const decoded = decodeControlSequences(stopCommand);
          if (decoded.length === 1 && decoded.charCodeAt(0) < 0x20) {
            stream.write(decoded);
          } else {
            stream.write(decoded + "\n");
          }
        } catch (e) {
          // Fallback to original behaviour on any failure
          stream.write(entry.stopCmd + "\n");
        }
      });
      broadcastToContainer(idt, "power", ansi("Node", "red", "Container Stopping."));
    }
  } catch (err) {
    sendEvent(ws, "error", `Power action failed: ${err.message}`);
  }
}

/*
 * Wait for a container to reach the running state (polling). Once running, attach logs for connected clients.
 */
async function waitForRunning(container, ws) {
  const resolved = findDataEntryByContainerOridt(container.id);
  const idt = resolved ? resolved.idt : container.id;

  let info;
  try {
    for (let attempts = 0; attempts < 20; attempts++) {
      try {
        info = await container.inspect();
        if (info.State && info.State.Running) break;
      } catch (err) {
        console.error("waitForRunning inspect failed:", err.message);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!info || !info.State.Running) {
      broadcastToContainer(idt, "error", "Container failed to reach running state.");
      return;
    }

    for (const c of clients.get(idt) || []) {
      try {
        streamLogs(c, container, container.id);
      } catch (err) {
        console.error("Failed to stream logs:", err);
      }
    }
  } catch (err) {
    console.error("waitForRunning fatal error:", err);
  }
}
async function StartContainer(containerIdOridt) {
  const resolved = findDataEntryByContainerOridt(containerIdOridt);
  if (!resolved) throw new Error("Data entry not found");
}
/* WebSocket authentication timeout and connection handling. */
const AUTH_TIMEOUT = 5000;
wss.on("connection", (ws) => {
  ws.isAuthenticated = false;
  ws.isAlive = true;

  const authTimer = setTimeout(() => { if (!ws.isAuthenticated) ws.terminate(); }, AUTH_TIMEOUT);
  ws.on("pong", () => (ws.isAlive = true));

  /* Handle incoming messages: auth, logs, stats, cmd, power actions. */
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendEvent(ws, "error", "Invalid JSON");
    }

    if (!ws.isAuthenticated) {
      if (msg.event === "auth" && msg.payload?.key === config.key) {
        ws.isAuthenticated = true;
        clearTimeout(authTimer);
        return sendEvent(ws, "auth", { success: true });
      } else {
        ws.close(1008, "Unauthorized");
        return;
      }
    }

    const { event, payload } = msg;
    const providedContainerId = payload?.containerId;
    if (!providedContainerId) return sendEvent(ws, "error", "containerId required");

    if (typeof providedContainerId !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(providedContainerId))
      return sendEvent(ws, "error", "Invalid containerId");

    const resolved = findDataEntryByContainerOridt(providedContainerId);
    const idt = resolved ? resolved.idt : providedContainerId;
    const currentContainerId = resolved ? resolved.entry.containerId : providedContainerId;
    const container = docker.getContainer(currentContainerId);

    try {
      switch (event) {
        case "logs":
          await streamLogs(ws, container, providedContainerId);
          break;
        case "stats":
          await streamStats(ws, container, providedContainerId);
          break;
        case "cmd":
          await executeCommand(ws, container, payload.command, providedContainerId);
          break;
        case "power:start":
        case "power:stop":
        case "power:restart":
          await performPower(ws, container, event.split(":")[1], providedContainerId);
          break;
        default:
          sendEvent(ws, "error", "Unknown event");
      }
    } catch (err) {
      sendEvent(ws, "error", `Handler error: ${err.message}`);
    }
  });

  ws.on("close", () => removeClient(ws));
  ws.on("error", () => removeClient(ws));
});

/* Periodic heartbeat to detect dead WebSocket clients. */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore ping errors */ }
  });
}, 30000);

/* Handle HTTP -> WebSocket upgrade requests. */
server.on("upgrade", (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
);

/* Simple REST endpoints for health/version/stats. */
app.get("/health", async (req, res) => {
  const dockerRunning = await isDockerRunning();
  res.json({
    status: dockerRunning ? "online" : "dockernotrunning",
    uptime: process.uptime(),
    node: "alive",
  });
});

app.get("/version", async (req, res) => {
  const version = "0.1-alpha-dev";
  res.json({ version });
});

app.get("/stats", (req, res) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const cpus = os.cpus();
    const load = os.loadavg();
    const uptime = os.uptime();

    res.json({
      stats: {
        totalRamGB: (totalRam / 1e9).toFixed(2),
        usedRamGB: ((totalRam - freeRam) / 1e9).toFixed(2),
        totalCpuCores: cpus.length,
        cpuModel: cpus[0]?.model || "unknown",
        cpuSpeed: cpus[0]?.speed || "unknown",
        osType: os.type(),
        osPlatform: os.platform(),
        osArch: os.arch(),
        osRelease: os.release(),
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        load1: load[0].toFixed(2),
        load5: load[1].toFixed(2),
        load15: load[2].toFixed(2),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Fetch and print the CLI/banner version from a remote JSON file. */
async function getVersion() {
  try {
    const res = await fetch("https://ma4z.is-a.dev/repo/version_library.json");
    const data = await res.json();
    const version = data["hydren:sr"]["talorix"]["daemon"];
    const ascii = `
 _____     _             
|_   _|_ _| | ___  _ __  
  | |/ _\` | |/ _ \| '_ \ 
  | | (_| | | (_) | | | |   ${version}
  |_|\__,_|_|\___/|_| |_|

Copyright © %s Talon Project

Website:  https://taloix.io
Source:   https://github.com/talorix/talon
`;
    const gray = '\x1b[90m';
    const reset = '\x1b[0m';
    const asciiWithColor = ascii.replace(version, reset + version + gray);
    console.log(gray + asciiWithColor + reset, new Date().getFullYear());
  } catch (err) {
    console.error('Failed to fetch version:', err);
  }
}

/* Start the HTTP server after printing version/banner. */
async function start() {
  await getVersion();
  server.listen(config.port, () => console.log("\x1b[32mTalon has been booted on " + config.port));
}
start();

// Alpha Release v1, Report bugs to ma5z_
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Docker = require("dockerode");
const docker = new Docker();
const os = require("os");

const ar = require("./backend/server/deploy.js");
const br = require("./backend/server/info.js");
const cr = require("./backend/server/action.js");
const dr = require("./backend/server/delete.js");
const er = require("./backend/server/filesystem.js");
const fr = require("./backend/server/reinstall.js");

const app = express();
app.use(express.json());

const config = require("./config.json");

// --- Helper: Check if Docker is running ---
async function isDockerRunning() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

// --- API Key Middleware ---
app.use((req, res, next) => {
  if (req.query.key !== config.key)
    return res.status(401).json({ error: "Invalid key" });
  next();
});

// --- REST routers ---
app.use("/server", ar);
app.use("/server", br);
app.use("/server", cr);
app.use("/server", dr);
app.use("/server/fs", er);
app.use("/server", fr);

// ANSI helpers
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

// Build colored message safely
function ansi(tag, color, message) {
  return `${ANSI[color] || ""}[${tag}]${ANSI.reset} ${message}`;
}

// --- HTTP server ---
const server = http.createServer(app);

// --- WebSocket server (improved) ---
const wss = new WebSocket.Server({ noServer: true });

// Maps for managing clients & resources per container
const clients = new Map(); // containerId => Set(ws)
const logStreams = new Map(); // containerId => { stream, refCount }
const statsIntervals = new Map(); // containerId => { intervalId, refCount }

// Helpers
function sendEvent(ws, event, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ event, payload, ts: new Date().toISOString() }));
    } catch (err) {
      console.error("sendEvent error", err);
    }
  }
}

function broadcastToContainer(containerId, event, payload) {
  const set = clients.get(containerId);
  if (!set) return;
  for (const c of set) sendEvent(c, event, payload);
}

function addClient(containerId, ws) {
  const set = clients.get(containerId) || new Set();
  set.add(ws);
  clients.set(containerId, set);
}

function removeClientFromAll(ws) {
  for (const [containerId, set] of clients.entries()) {
    if (set.has(ws)) {
      set.delete(ws);
      // If no more clients for this container, cleanup streams/intervals
      if (set.size === 0) {
        clients.delete(containerId);
        cleanupLogStream(containerId);
        cleanupStatsInterval(containerId);
      }
    }
  }
}

// Cleanup helpers
function cleanupLogStream(containerId) {
  const entry = logStreams.get(containerId);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    try {
      entry.stream.destroy();
    } catch (e) {}
    logStreams.delete(containerId);
  }
}

function cleanupStatsInterval(containerId) {
  const entry = statsIntervals.get(containerId);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    clearInterval(entry.intervalId);
    statsIntervals.delete(containerId);
  }
}

// Stream logs (single broadcaster per container)
function streamLogs(ws, container, containerId) {
  addClient(containerId, ws);

  // If a log stream already exists, just increase refCount and return
  if (logStreams.has(containerId)) {
    logStreams.get(containerId).refCount++;
    return;
  }

  // Create new log stream and broadcast to all clients for containerId
  container.logs(
    {
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    },
    (err, stream) => {
      if (err) {
        sendEvent(ws, "error", err.message);
        return;
      }

      // Save stream ref
      logStreams.set(containerId, {
        stream,
        refCount: (clients.get(containerId) || new Set()).size,
      });

      stream.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        // broadcast raw output (legacy behavior) and also tag as cmd/event if desired
        // keep backward compatibility: plain text messages for logs
        for (const c of clients.get(containerId) || []) {
          if (c.readyState === WebSocket.OPEN) {
            // If client expects JSON events, you can wrap; here we keep sending raw logs (as before)
            c.send(text);
          }
        }
      });

      stream.on("error", (err) => {
        broadcastToContainer(
          containerId,
          "error",
          `Log stream error: ${err.message}`
        );
      });

      stream.on("end", () => {
        broadcastToContainer(containerId, "info", "Log stream ended");
      });

      // When the stream is destroyed, ensure it's cleaned up
      ws.once("close", () => {
        cleanupLogStream(containerId);
      });
    }
  );
}

// Stream stats (per-container interval, reused)
async function streamStats(ws, container, containerId) {
  addClient(containerId, ws);

  // If interval exists, just increment refCount
  if (statsIntervals.has(containerId)) {
    statsIntervals.get(containerId).refCount++;
    return;
  }

  // create interval
  const intervalId = setInterval(async () => {
    const set = clients.get(containerId);
    if (!set || set.size === 0) return;

    try {
      const stats = await new Promise((resolve, reject) => {
        container.stats({ stream: false }, (err, s) =>
          err ? reject(err) : resolve(s)
        );
      });

      const containerInfo = await container.inspect();
      const payload = { stats, status: containerInfo.State.Status };

      // broadcast structured stats payload
      broadcastToContainer(containerId, "stats", payload);
    } catch (err) {
      broadcastToContainer(containerId, "error", err.message);
    }
  }, 2000);

  statsIntervals.set(containerId, {
    intervalId,
    refCount: (clients.get(containerId) || new Set()).size,
  });
}

// Execute command - run via container.exec and return output to caller only
async function executeCommand(ws, container, command) {
  try {
    if (!command || typeof command !== "string")
      return sendEvent(ws, "error", "Invalid command");

    const exec = await container.exec({
      Cmd: ["sh", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ Detach: false });

    stream.on("data", (chunk) => {
      sendEvent(ws, "cmd", chunk.toString("utf8"));
    });

    stream.on("error", (err) => {
      sendEvent(ws, "error", err.message);
    });

    stream.on("end", () => {
      sendEvent(ws, "cmd", "[COMMAND OUTPUT END]");
    });
  } catch (err) {
    sendEvent(ws, "error", err.message);
  }
}

// Improved performPower: send broadcasts to container subscribers where helpful
async function performPower(ws, container, action, containerId) {
  try {
    const info = await container.inspect();

    if (action === "start") {
      if (info.State.Running)
        return sendEvent(ws, "power", "Container is already running.");

      await container.start();
      sendEvent(ws, "power", "Starting container...");
      broadcastToContainer(containerId, "power", "Starting container...");
      await waitForRunning(container, ws);
    } else if (action === "stop") {
      if (!info.State.Running)
        return sendEvent(ws, "power", "Container is already stopped.");

      await container.kill();
      sendEvent(ws, "power", "Container stopped successfully.");
      broadcastToContainer(containerId, "power", "Container stopped");
    } else if (action === "restart") {
      sendEvent(ws, "power", "Restarting container...");
      broadcastToContainer(containerId, "power", "Restarting container...");
      await container.restart();
      await waitForRunning(container, ws);
    } else {
      throw new Error("Invalid power action.");
    }
  } catch (err) {
    sendEvent(ws, "error", err.message || "An unexpected error occurred.");
  }
}

// Wait for running then attach logs for requester (keeps old behavior)
async function waitForRunning(container, ws) {
  try {
    let info;
    do {
      await new Promise((r) => setTimeout(r, 500));
      info = await container.inspect();
    } while (!info.State.Running);

    // Attach logs and broadcast to all clients for this container
    streamLogs(ws, container, container.id);
  } catch (err) {
    sendEvent(ws, "error", `Failed to attach logs: ${err.message}`);
  }
}

// --- Authentication & connection lifecycle ---
// require an auth message quickly or terminate
const AUTH_TIMEOUT = 5000;

wss.on("connection", (ws, req) => {
  ws.isAuthenticated = false;
  ws.isAlive = true;
  // auto-terminate if client doesn't auth within AUTH_TIMEOUT
  const authTimer = setTimeout(() => {
    if (!ws.isAuthenticated) {
      ws.terminate();
    }
  }, AUTH_TIMEOUT);

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return sendEvent(ws, "error", "Invalid JSON");
    }

    // If not authenticated, only accept auth event
    if (!ws.isAuthenticated) {
      if (data.event === "auth" && data.payload?.key === config.key) {
        ws.isAuthenticated = true;
        clearTimeout(authTimer);
        sendEvent(ws, "auth", { success: true });
        return;
      } else {
        // unauthorized - close with policy violation
        ws.close(1008, "Unauthorized");
        return;
      }
    }

    // Authenticated: handle events
    const { event, payload } = data;
    const containerId = payload?.containerId;
    if (!containerId) return sendEvent(ws, "error", "containerId is required");

    // Basic containerId validation to avoid injection (adjust pattern as needed)
    if (
      typeof containerId !== "string" ||
      !/^[a-zA-Z0-9_.-]+$/.test(containerId)
    ) {
      return sendEvent(ws, "error", "Invalid containerId");
    }

    const container = docker.getContainer(containerId);

    try {
      switch (event) {
        case "logs":
          streamLogs(ws, container, containerId);
          break;
        case "stats":
          streamStats(ws, container, containerId);
          break;
        case "cmd":
          await executeCommand(ws, container, payload.command);
          break;
        case "power:start":
        case "power:stop":
        case "power:restart":
          await performPower(ws, container, event.split(":")[1], containerId);
          break;
        default:
          sendEvent(ws, "error", "Unknown event");
      }
    } catch (err) {
      sendEvent(ws, "error", err.message);
    }
  });

  ws.on("close", () => {
    // cleanup all references
    removeClientFromAll(ws);
  });

  ws.on("error", (err) => {
    console.error("WS Error:", err);
    removeClientFromAll(ws);
  });
});

// heartbeat: detect dead connections
const HEARTBEAT_INTERVAL = 30000;
const hbInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, HEARTBEAT_INTERVAL);

// --- Upgrade HTTP to WebSocket (you had this already) ---
server.on("upgrade", (req, socket, head) => {
  // Optional: check origin here to restrict connections
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Clean-up on shutdown
process.on("SIGINT", () => {
  clearInterval(hbInterval);
  wss.close();
  server.close(() => process.exit(0));
});

// --- WebSocket helpers ---
function addClient(containerId, ws) {
  if (!clients[containerId]) clients[containerId] = [];
  clients[containerId].push(ws);
}

function streamLogs(ws, container, containerId) {
  addClient(containerId, ws);

  container.logs(
    {
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    },
    (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ event: "error", payload: err.message }));
        return;
      }

      stream.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk.toString("utf8"));
        }
      });

      stream.on("error", (err) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "error", payload: err.message }));
        }
      });

      ws.on("close", () => {
        stream.destroy();
      });
    }
  );
}

async function streamStats(ws, container, containerId) {
  addClient(containerId, ws);

  const interval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(interval);

    try {
      // Fetch stats
      const stats = await new Promise((resolve, reject) => {
        container.stats({ stream: false }, (err, s) =>
          err ? reject(err) : resolve(s)
        );
      });

      // Fetch status
      const containerInfo = await container.inspect();
      const status = containerInfo.State.Status; // e.g., "running", "exited"

      ws.send(
        JSON.stringify({
          event: "stats",
          payload: {
            stats,
          },
        })
      );
    } catch (err) {
      ws.send(JSON.stringify({ event: "error", payload: err.message }));
    }
  }, 2000);

  ws.on("close", () => clearInterval(interval));
}

async function executeCommand(ws, container, command) {
  try {
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });

    stream.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ event: "cmd", payload: chunk.toString("utf8") })
        );
      }
    });

    stream.on("error", (err) => {
      ws.send(JSON.stringify({ event: "error", payload: err.message }));
    });

    stream.write(command + "\n");
    stream.end();
  } catch (err) {
    ws.send(JSON.stringify({ event: "error", payload: err.message }));
  }
}
async function performPower(ws, container, action) {
  try {
    const info = await container.inspect();

    if (action === "start") {
      if (info.State.Running) {
        return ws.send(
          JSON.stringify({
            event: "power",
            payload: ansi("Node", "green", "Container is already running."),
          })
        );
      }

      await container.start();
      ws.send(
        JSON.stringify({
          event: "power",
          payload: ansi("Node", "green", "Starting container..."),
        })
      );

      await waitForRunning(container, ws);
    } else if (action === "stop") {
      if (!info.State.Running) {
        return ws.send(
          JSON.stringify({
            event: "power",
            payload: ansi("Node", "red", "Container is already stopped."),
          })
        );
      }

      await container.kill();
      ws.send(
        JSON.stringify({
          event: "power",
          payload: ansi("Node", "red", "Container stopped successfully."),
        })
      );
    } else if (action === "restart") {
      ws.send(
        JSON.stringify({
          event: "power",
          payload: ansi("power", "yellow", "Restarting container..."),
        })
      );

      await container.restart();
      await waitForRunning(container, ws);
    } else {
      throw new Error("Invalid power action.");
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        event: "error",
        payload: ansi(
          "error",
          "red",
          err.message || "An unexpected error occurred."
        ),
      })
    );
  }
}
async function waitForRunning(container, ws) {
  try {
    let info;
    do {
      await new Promise((r) => setTimeout(r, 500));
      info = await container.inspect();
    } while (!info.State.Running);
    streamLogs(ws, container, container.id);
  } catch (err) {
    ws.send(
      JSON.stringify({
        event: "error",
        payload: `Failed to attach logs: ${err.message}`,
      })
    );
  }
}

// --- REST endpoints ---
app.get("/health", async (req, res) => {
  const dockerRunning = await isDockerRunning();
  res.json({
    status: dockerRunning ? "online" : "dockernotrunning",
    uptime: process.uptime(),
    node: "alive",
  });
});

app.get("/stats", async (req, res) => {
  try {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const usedRam = totalRam - freeRam;
    const totalCpu = os.cpus().length;
    res.json({
      totalRamGB: (totalRam / 1e9).toFixed(2),
      usedRamGB: (usedRam / 1e9).toFixed(2),
      totalCpuCores: totalCpu,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
server.listen(3000, () => console.log("Talorix API + WS running on port 3000"));

// ftp.js
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const FtpSrv = require("ftp-srv");

const DATA_PATH = path.join(__dirname, "../../data.json");
const CONFIG_PATH = path.join(__dirname, "../../config.json");
const SERVERS_DIR = path.join(__dirname, "../../data");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const FTP_PORT = config.ftpport;
const FTP_HOST = "0.0.0.0";

/* ---------------- disk helpers ---------------- */
async function getFolderSize(dir) {
  let total = 0;
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await getFolderSize(full);
      else if (e.isFile()) total += (await fsPromises.stat(full)).size;
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("getFolderSize:", err);
  }
  return total;
}

async function checkQuota(tid, addBytes) {
  const entryDir = path.join(SERVERS_DIR, tid);
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const entry = data[tid];
  const allowedGB = entry?.disk ?? Infinity;
  const allowedBytes = allowedGB === Infinity ? Infinity : allowedGB * 1e9;

  const current = await getFolderSize(entryDir);
  if (current + addBytes > allowedBytes) throw new Error("QuotaExceeded");
}

/* ---------------- FTP server ---------------- */
function startFtpServer() {
  const ftp = new FtpSrv({
    url: `ftp://${FTP_HOST}:${FTP_PORT}`,
    anonymous: false,
  });

  ftp.on("login", ({ username, password }, resolve, reject) => {
    if (!username.startsWith("talorix.")) return reject(new Error("Invalid username"));

    const tid = username.slice("talorix.".length);
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const entry = data[tid];

    if (!entry || entry.ftpPassword !== password) return reject(new Error("Invalid credentials"));

    const root = path.join(SERVERS_DIR, tid);
    fs.mkdirSync(root, { recursive: true });

    resolve({ root, cwd: "/" });
  });

  // intercept file upload to enforce quota
  ftp.on("STOR", async (error, fileName, stream, conn) => {
    if (error) return;

    const tid = conn.username.slice("talorix.".length);
    const absPath = path.join(SERVERS_DIR, tid, fileName);

    try {
      let written = 0;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(absPath);

        stream.on("data", async (chunk) => {
          written += chunk.length;
          try {
            await checkQuota(tid, written);
          } catch (err) {
            const e = new Error("Disk quota exceeded");
            e.code = "QUOTA";
            stream.destroy(e);
            ws.destroy();
          }
        });

        stream.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);

        stream.pipe(ws);
      });
    } catch (err) {
      console.log(err.message);
    }
  });

  return ftp.listen().then(() => {
    console.log(`FTP is Listening on ${FTP_PORT}`);
  });
}

module.exports = { startFtpServer };

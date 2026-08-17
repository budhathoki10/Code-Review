// Windows/next dev + Turbopack spawns a detached start-server.js process that
// nodemon's restart doesn't reliably terminate, leaving a stale server bound
// to the port. Force-kill whatever's actually listening before each restart.
const { execSync } = require("child_process");

const port = process.argv[2] || "3000";

let output;
try {
  output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
} catch {
  process.exit(0);
}

const pids = new Set();
for (const line of output.split("\n")) {
  if (line.includes(`:${port} `) && line.includes("LISTENING")) {
    const parts = line.trim().split(/\s+/);
    pids.add(parts[parts.length - 1]);
  }
}

for (const pid of pids) {
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
    console.log(`[dev] killed stale process on port ${port} (pid ${pid})`);
  } catch {
    // already gone
  }
}

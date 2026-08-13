import net from "node:net";
import path from "node:path";
import { stablePortFor } from "../server/projects.js";

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const preferred = stablePortFor(projectRoot);

function claim(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
}

let port;
try { port = await claim(preferred); } catch { port = await claim(0); }
process.stdout.write(`${port}\n`);

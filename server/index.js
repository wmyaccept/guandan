import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { attachSockets } from "./rooms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html") || req.path.endsWith(".svg")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
  next();
});
app.use(express.static(path.join(__dirname, "../public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html") || filePath.endsWith(".svg")) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    }
  }
}));
app.get("/health", (_req, res) => res.json({ ok: true }));

attachSockets(io);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`掼蛋桌已开：http://localhost:${port}`);
});

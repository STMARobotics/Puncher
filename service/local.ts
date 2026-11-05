import { createServer } from "node:http";
import { dispatch } from "./api";
import { store } from "./runtime";
const db = store();
createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 512 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const url = new URL(req.url || "/", "http://localhost");
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400);
      res.end('{"message":"Invalid JSON"}');
      return;
    }
    const result = await dispatch(
      {
        method: req.method || "GET",
        path: url.pathname,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join("; ") : v,
          ]),
        ),
        body: parsed,
        query: Object.fromEntries(url.searchParams),
      },
      db,
    );
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch {
    res.writeHead(500);
    res.end('{"message":"Local API failed"}');
  }
}).listen(3000, "127.0.0.1", () =>
  console.log("Puncher API http://127.0.0.1:3000"),
);

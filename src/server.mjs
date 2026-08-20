import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RecipeValidationError,
  scaleRecipe,
} from "./components/recipe-scaler.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const maxBodyBytes = 64 * 1024;
const staticAssets = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["public/app.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new RecipeValidationError("request body is too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RecipeValidationError("request body must be valid JSON");
  }
}

async function serveStatic(pathname, response) {
  const asset = staticAssets.get(pathname);
  if (!asset) {
    return false;
  }

  const [relativePath, contentType] = asset;
  const body = await readFile(join(projectRoot, relativePath));
  response.writeHead(200, { "content-type": contentType });
  response.end(body);
  return true;
}

export function createRecipeServer() {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scale-recipe") {
        const recipe = await readJsonBody(request);
        sendJson(response, 200, scaleRecipe(recipe));
        return;
      }

      if (request.method === "GET" && await serveStatic(url.pathname, response)) {
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof RecipeValidationError) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      sendJson(response, 500, { error: "internal server error" });
    }
  });
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const configuredPort = Number(process.env.PORT ?? 3000);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 3000;

  createRecipeServer().listen(port, "127.0.0.1", () => {
    console.log(`PRarness recipe scaler: http://localhost:${port}`);
  });
}

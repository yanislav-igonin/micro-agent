import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { listJournals, readJournal } from "./viewer/server.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const viewerRoot = fileURLToPath(new URL("./viewer", import.meta.url));

function sendJson(
	response: import("node:http").ServerResponse,
	statusCode: number,
	value: unknown,
) {
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	response.end(JSON.stringify(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function journalApi(): Plugin {
	return {
		name: "journal-api",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				const isListRoute = url.pathname === "/api/journals";
				const isReadRoute = url.pathname.startsWith("/api/journals/");
				if (!isListRoute && !isReadRoute) {
					next();
					return;
				}

				if (request.method !== "GET") {
					response.setHeader("Allow", "GET");
					sendJson(response, 405, { error: "Method not allowed" });
					return;
				}

				try {
					if (isListRoute) {
						sendJson(response, 200, await listJournals(projectRoot));
						return;
					}

					const encodedName = url.pathname.slice("/api/journals/".length);
					let name: string;
					try {
						name = decodeURIComponent(encodedName);
					} catch {
						sendJson(response, 400, { error: "Invalid journal name" });
						return;
					}
					const text = await readJournal(projectRoot, name);
					response.statusCode = 200;
					response.setHeader(
						"Content-Type",
						"application/x-ndjson; charset=utf-8",
					);
					response.setHeader("Cache-Control", "no-store");
					response.end(text);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "Invalid journal name"
					) {
						sendJson(response, 400, { error: error.message });
					} else if (isNodeError(error) && error.code === "ENOENT") {
						sendJson(response, 404, { error: "Journal no longer exists" });
					} else {
						sendJson(response, 500, {
							error:
								error instanceof Error
									? error.message
									: "Unable to read journals",
						});
					}
				}
			});
		},
	};
}

export default defineConfig({
	root: viewerRoot,
	plugins: [react(), journalApi()],
	server: {
		host: "127.0.0.1",
	},
});

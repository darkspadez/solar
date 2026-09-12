import { basename } from "node:path";
import { spawn } from "node:child_process";
import {
	buildFrpcArgs,
	buildFrpcEndpoint,
	DEFAULT_FRPC_SERVER_PORT,
	getRepositoryName,
	isFrpcAvailable,
} from "./frpc";

if (!isFrpcAvailable()) {
	console.log("[frpc] Tunnel disabled: frpc is not available on PATH.");
	process.exit(0);
}

const serverAddr = process.env.FRPC_SERVER_ADDR;
const token = process.env.FRPC_AUTH_TOKEN;
if (!serverAddr && !token) {
	console.log(
		"[frpc] Tunnel disabled: FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN are not set.",
	);
	process.exit(0);
}
if (!serverAddr || !token) {
	console.warn(
		"[frpc] Tunnel disabled: set both FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN.",
	);
	process.exit(0);
}

const serverPort = Number(
	process.env.FRPC_SERVER_PORT ?? DEFAULT_FRPC_SERVER_PORT,
);
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
	console.error(
		`[frpc] Tunnel disabled: invalid FRPC_SERVER_PORT "${process.env.FRPC_SERVER_PORT}".`,
	);
	process.exit(0);
}

const localPort = Number(process.env.PORT);
const repositoryName = getRepositoryName(process.cwd());
const worktreeName = basename(process.cwd());
const { subdomain, url } = buildFrpcEndpoint(
	repositoryName,
	worktreeName,
	process.env.FRPC_SUBDOMAIN_HOST,
);
const args = buildFrpcArgs({
	serverAddr,
	serverPort,
	token,
	proxyName: subdomain,
	localPort,
	subdomain,
});

console.log(`[frpc] Starting tunnel for subdomain: ${subdomain}`);
console.log(`[frpc] ${url ? `URL=${url}` : `Subdomain=${subdomain}`}`);

const child = spawn("frpc", args, {
	cwd: process.cwd(),
	env: { ...process.env },
	stdio: "inherit",
});

let stopping = false;
function stop(signal: NodeJS.Signals) {
	if (stopping) return;
	stopping = true;
	child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));

child.on("error", (error) => {
	console.error(`[frpc] ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (!stopping && code !== 0) {
		console.error(
			`[frpc] Tunnel exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
		);
	}
	process.exitCode = code ?? 1;
});

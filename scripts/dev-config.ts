import { basename } from "node:path";
import {
	buildFrpcEndpoint,
	getRepositoryName,
	isFrpcAvailable,
	type FrpcEndpoint,
} from "./frpc";

function getFrpEndpoint(): FrpcEndpoint {
	if (!process.env.FRPC_SERVER_ADDR || !process.env.FRPC_AUTH_TOKEN) {
		throw new Error(
			"FRP is not configured: set FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN.",
		);
	}
	if (!isFrpcAvailable()) {
		throw new Error("FRP is not available: install frpc or add it to PATH.");
	}

	return buildFrpcEndpoint(
		getRepositoryName(process.cwd()),
		basename(process.cwd()),
		process.env.FRPC_SUBDOMAIN_HOST,
	);
}

function printFrpEndpoint(args: string[]) {
	const endpoint = getFrpEndpoint();
	const hostname = endpoint.url ? new URL(endpoint.url).hostname : undefined;

	if (args.includes("--json")) {
		console.log(JSON.stringify({ ...endpoint, hostname: hostname ?? null }));
		return;
	}
	if (args.includes("--subdomain")) {
		console.log(endpoint.subdomain);
		return;
	}
	if (args.includes("--hostname")) {
		if (!hostname) {
			throw new Error(
				"FRPC_SUBDOMAIN_HOST is not set; cannot build the hostname.",
			);
		}
		console.log(hostname);
		return;
	}
	if (!endpoint.url) {
		throw new Error(
			"FRPC_SUBDOMAIN_HOST is not set; use --subdomain or configure the host.",
		);
	}
	console.log(endpoint.url);
}

try {
	printFrpEndpoint(process.argv.slice(3));
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

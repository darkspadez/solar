/**
 * Solar deployment. One script, two targets, configured via
 * SOLAR_<TARGET>_* env vars (staging defaults mirror the historical
 * deploy-staging.ts):
 *
 *   bun run deploy:staging      # solar-pi:staging-* images, pi-engine build
 *   bun run deploy:production   # solar:production-* images, current prod build
 *
 * Both targets: build on the target's Docker context, recreate the running
 * compose-managed service, wait for /healthz, export history, prune old tags.
 */
import { spawnSync } from "node:child_process";

type Target = "production" | "staging";

const TARGET: Target | undefined = Bun.argv[2] as Target | undefined;
if (TARGET !== "production" && TARGET !== "staging") {
	console.error("usage: bun run scripts/deploy.ts <staging|production>");
	process.exit(1);
}

const PREFIX = TARGET.toUpperCase();
function env(name: string, fallback?: string): string | undefined {
	return process.env[`SOLAR_${PREFIX}_${name}`] ?? fallback;
}

const defaults: Record<Target, { imageName: string; tagPrefix: string }> = {
	// Staging hosts the pi-engine build; production carries the current build.
	staging: { imageName: "solar-pi", tagPrefix: "staging" },
	production: { imageName: "solar", tagPrefix: "production" },
};

const { imageName: defaultImageName, tagPrefix } = defaults[TARGET];

const context = env("DOCKER_CONTEXT") ?? "dolphin";
const sshHost = env("SSH_HOST") ?? context;
const deployUrl = (env("URL") ?? "https://solar.home.cowger.us").replace(
	/\/$/,
	"",
);
const containerName = env("CONTAINER_NAME") ?? "Solar";
const imageName = env("IMAGE_NAME") ?? defaultImageName;
const imageRetention = Number.parseInt(env("IMAGE_RETAIN") ?? "3", 10);
const healthTimeout = Number.parseInt(env("HEALTH_TIMEOUT") ?? "60", 10);
const targetPlatform = env("TARGET_PLATFORM") ?? "linux/amd64";

const timestamp = new Date()
	.toISOString()
	.replace(/[-:]/g, "")
	.replace(/\.\d{3}Z$/, "")
	.replace("T", "-");
const newTag = `${imageName}:${tagPrefix}-${timestamp}`;
const latestTag = `${imageName}:${tagPrefix}-latest`;

function runCommand(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; fatal?: boolean; stream?: boolean } = {},
) {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		env: options.env,
		stdio: options.stream ? "inherit" : "pipe",
	});
	const success = result.status === 0;
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";

	if (!success && options.fatal !== false) {
		if (stderr) console.error(stderr);
		console.error(`\nCommand failed: ${command} ${args.join(" ")}`);
		process.exit(1);
	}

	return { success, stdout, stderr };
}

function docker(
	args: string[],
	options: { fatal?: boolean; stream?: boolean } = {},
) {
	return runCommand("docker", ["--context", context, ...args], options);
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function compose(workingDir: string, project: string, service: string) {
	return runCommand("ssh", [
		sshHost,
		`cd ${shellQuote(workingDir)} && docker compose --project-name ${shellQuote(project)} up --detach --force-recreate ${shellQuote(service)}`,
	]);
}

function sleep(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log(`Solar ${TARGET} deploy`);
console.log(`  Context: ${context}`);
console.log(`  SSH host: ${sshHost}`);
console.log(`  URL: ${deployUrl}`);
console.log(`  Container: ${containerName}`);
console.log(`  New image: ${newTag}`);

const inspect = docker(["inspect", "--format", "{{json .}}", containerName], {
	fatal: false,
});
let previous:
	| {
			image: string;
			imageId: string;
			status: string;
			composeWorkingDir: string;
			composeProject: string;
			composeService: string;
	  }
	| undefined;
if (inspect.success && inspect.stdout) {
	try {
		const container = JSON.parse(inspect.stdout) as {
			Config?: { Image?: string; Labels?: Record<string, string> };
			Image?: string;
			State?: { Status?: string };
		};
		if (!container.Config?.Image || !container.Image)
			throw new Error("missing image details");
		const composeWorkingDir =
			container.Config.Labels?.["com.docker.compose.project.working_dir"];
		const composeProject =
			container.Config.Labels?.["com.docker.compose.project"];
		// Service name is read from compose metadata rather than assumed.
		const composeService =
			container.Config.Labels?.["com.docker.compose.service"] ?? "solar";
		if (!composeWorkingDir || !composeProject)
			throw new Error("missing Compose project metadata");
		previous = {
			image: container.Config.Image,
			imageId: container.Image,
			status: container.State?.Status ?? "unknown",
			composeWorkingDir,
			composeProject,
			composeService,
		};
		console.log(
			`  Current image: ${previous.image} (${previous.imageId}, ${previous.status})`,
		);
		console.log(
			`  Compose: ${composeProject} service=${composeService} (${composeWorkingDir})`,
		);
	} catch {
		console.error(`\nCould not read the current image for ${containerName}.`);
		process.exit(1);
	}
}

if (!previous) {
	console.error(
		"\nCannot deploy without an existing Compose-managed Solar container.",
	);
	process.exit(1);
}

console.log("\nBuilding on the target host...");
docker(
	["build", "--platform", targetPlatform, "-t", newTag, "-t", latestTag, "."],
	{ stream: true },
);
console.log(`\nRecreating ${containerName} through Compose...`);
compose(
	previous.composeWorkingDir,
	previous.composeProject,
	previous.composeService,
);

const updated = docker(["inspect", "--format", "{{.Image}}", containerName], {
	fatal: false,
});
if (
	!updated.success ||
	!updated.stdout ||
	(previous && updated.stdout === previous.imageId)
) {
	console.error("\nDeploy did not replace the running image.");
	process.exit(1);
}

console.log(`  Image updated: ${updated.stdout}`);
console.log(`\nWaiting for ${deployUrl}/healthz...`);
let healthy = false;
for (let elapsed = 1; elapsed <= healthTimeout; elapsed += 1) {
	await sleep(1000);
	try {
		const response = await fetch(`${deployUrl}/healthz`, {
			signal: AbortSignal.timeout(5000),
		});
		const body = (await response.json()) as { ok?: boolean };
		if (response.ok && body.ok === true) {
			healthy = true;
			console.log(`  Healthy after ${elapsed}s.`);
			break;
		}
	} catch {
		// The server is still starting.
	}
}

if (!healthy) {
	console.error("\nHealth check failed. Recent container logs:");
	docker(["logs", "--tail", "50", containerName], { fatal: false });
	process.exit(1);
}

const apiKey = env("API_KEY");
if (apiKey) {
	const historyOutput =
		env("HISTORY_OUTPUT") ?? `.${TARGET}-history/${timestamp}.json`;
	console.log(`\nExporting chat history to ${historyOutput}...`);
	runCommand(
		"bun",
		[
			"run",
			"solar",
			"history",
			"export-all",
			"--url",
			deployUrl,
			"--output",
			historyOutput,
		],
		{
			env: {
				...process.env,
				SOLAR_URL: deployUrl,
				SOLAR_API_KEY: apiKey,
			},
			stream: true,
		},
	);
}

const images = docker(["images", imageName, "--format", "{{.Tag}}"], {
	fatal: false,
});
if (images.success) {
	const staleTags = images.stdout
		.split("\n")
		.filter(
			(tag) => tag.startsWith(`${tagPrefix}-`) && tag !== `${tagPrefix}-latest`,
		)
		.slice(imageRetention);
	for (const tag of staleTags)
		docker(["rmi", `${imageName}:${tag}`], { fatal: false });
}

console.log(`\nDeploy complete: ${newTag}`);

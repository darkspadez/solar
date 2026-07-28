import { runMigration } from "./migrate-v1-v2/index";

function value(name: string): string { const index = Bun.argv.indexOf(name); const result = Bun.argv[index + 1]; if (index < 0 || !result || result.startsWith("--")) throw new Error(`missing ${name}`); return result; }
const userMapPath = Bun.argv.includes("--user-map") ? value("--user-map") : undefined;
const report = await runMigration({ sourceDb: value("--source-db"), sourceAssets: value("--source-assets"), targetDb: value("--target-db"), targetAssets: value("--target-assets"), reportPath: value("--report"), dryRun: Bun.argv.includes("--dry-run"), allowAmbiguousOrder: Bun.argv.includes("--allow-ambiguous-order"), force: Bun.argv.includes("--force"), userMap: userMapPath ? await Bun.file(userMapPath).json() : undefined });
if (report.failures.length) process.exitCode = 1;

/**
 * Rollback Extension
 *
 * Claude Code-style restore for pi:
 * - automatically snapshots workspace state when code changes
 * - can restore conversation to any prior visible point
 * - can restore code, conversation, or both
 *
 * Design:
 * - baseline snapshot is captured for the first prompt in a session branch
 * - after each completed agent run, a new snapshot is saved only if the
 *   workspace tree changed
 * - restore works for any prior user/assistant message; if that point did not
 *   create a new snapshot, the extension uses the nearest earlier snapshot on
 *   that branch path
 *
 * Requirements:
 * - Must be inside a git repository
 * - Snapshots include tracked + untracked non-ignored files
 * - Ignored files are preserved on restore
 *
 * Commands:
 * - /restore       Restore code + conversation to any prior point
 * - /rollback      Alias for /restore
 * - /rollback-gc   Remove stale snapshot refs for the current session
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionTreeNode,
} from "@mariozechner/pi-coding-agent";

const SNAPSHOT_TYPE = "rollback-snapshot";
const SNAPSHOT_REF_PREFIX = "refs/pi/rollback";
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "pi rollback",
	GIT_AUTHOR_EMAIL: "pi@localhost",
	GIT_COMMITTER_NAME: "pi rollback",
	GIT_COMMITTER_EMAIL: "pi@localhost",
};

interface RollbackSnapshotData {
	version: 2;
	snapshotId: string;
	targetId: string;
	ref: string;
	tree: string;
	repoRoot: string;
	kind: "baseline" | "post-run";
	label: string;
	promptPreview?: string;
	assistantPreview?: string;
	createdAt: string;
}

interface RollbackSnapshot {
	entryId: string;
	timestamp: string;
	data: RollbackSnapshotData;
}

interface RestorePoint {
	entryId: string;
	depth: number;
	timestamp: string;
	label: string;
	preview: string;
	exactSnapshot: boolean;
	hasSnapshot: boolean;
	resolvedSnapshot?: RollbackSnapshot;
}

type RestoreMode = "both" | "conversation" | "code";

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

function execCommand(
	command: string,
	args: string[],
	options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<CommandResult> {
	return new Promise((resolvePromise, reject) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			resolvePromise({ stdout, stderr, code: code ?? 0 });
		});
	});
}

async function runGit(repoRoot: string, args: string[], env?: Record<string, string | undefined>): Promise<string> {
	const result = await execCommand("git", args, { cwd: repoRoot, env });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed with exit code ${result.code}`);
	}
	return result.stdout;
}

async function tryGit(repoRoot: string, args: string[], env?: Record<string, string | undefined>): Promise<string | undefined> {
	const result = await execCommand("git", args, { cwd: repoRoot, env });
	if (result.code !== 0) return undefined;
	return result.stdout;
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
	const result = await execCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) return undefined;
	return result.stdout.trim();
}

function splitNull(value: string): string[] {
	return value.split("\0").filter((item) => item.length > 0);
}

function truncate(text: string | undefined, maxLength = 80): string | undefined {
	const normalized = text?.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function getLastMessageText(entries: SessionEntry[], role: "user" | "assistant"): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== role) continue;
		const text = extractText(entry.message.content);
		if (text.trim()) return text;
	}
	return undefined;
}

function isRollbackSnapshotData(data: unknown): data is RollbackSnapshotData {
	if (!data || typeof data !== "object") return false;
	const snapshot = data as Partial<RollbackSnapshotData>;
	return (
		snapshot.version === 2 &&
		typeof snapshot.snapshotId === "string" &&
		typeof snapshot.targetId === "string" &&
		typeof snapshot.ref === "string" &&
		typeof snapshot.tree === "string" &&
		typeof snapshot.repoRoot === "string" &&
		(snapshot.kind === "baseline" || snapshot.kind === "post-run") &&
		typeof snapshot.label === "string" &&
		typeof snapshot.createdAt === "string"
	);
}

function getSnapshotEntries(ctx: ExtensionContext): RollbackSnapshot[] {
	return ctx.sessionManager
		.getEntries()
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.flatMap((entry) => {
			if (entry.customType !== SNAPSHOT_TYPE || !isRollbackSnapshotData(entry.data)) return [];
			return [{ entryId: entry.id, timestamp: entry.timestamp, data: entry.data }];
		})
		.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function getResolvedSnapshot(ctx: ExtensionContext, targetId: string): RollbackSnapshot | undefined {
	const path = ctx.sessionManager.getBranch(targetId);
	const positions = new Map(path.map((entry, index) => [entry.id, index]));
	let best: RollbackSnapshot | undefined;
	let bestDepth = -1;

	for (const snapshot of getSnapshotEntries(ctx)) {
		const depth = positions.get(snapshot.data.targetId);
		if (depth === undefined) continue;
		if (!best || depth > bestDepth || (depth === bestDepth && snapshot.timestamp > best.timestamp)) {
			best = snapshot;
			bestDepth = depth;
		}
	}

	return best;
}

function getExactSnapshot(ctx: ExtensionContext, targetId: string): RollbackSnapshot | undefined {
	return getSnapshotEntries(ctx)
		.filter((snapshot) => snapshot.data.targetId === targetId)
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
}

function resolveInside(repoRoot: string, relativePath: string): string {
	const target = resolve(repoRoot, relativePath);
	const normalizedRoot = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
	if (target !== repoRoot && !target.startsWith(normalizedRoot)) {
		throw new Error(`Refusing to operate outside repository root: ${relativePath}`);
	}
	return target;
}

async function buildWorkingTree(repoRoot: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-rollback-index-"));
	const tempIndex = join(tempDir, "index");

	try {
		await runGit(repoRoot, ["add", "-A"], { GIT_INDEX_FILE: tempIndex });
		return (await runGit(repoRoot, ["write-tree"], { GIT_INDEX_FILE: tempIndex })).trim();
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function createSnapshotRef(repoRoot: string, tree: string, sessionId: string, snapshotId: string): Promise<string> {
	const head = (await tryGit(repoRoot, ["rev-parse", "--verify", "HEAD"]))?.trim();
	const commit = (
		await runGit(
			repoRoot,
			["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `pi rollback snapshot ${snapshotId}`],
			GIT_IDENTITY,
		)
	).trim();
	const ref = `${SNAPSHOT_REF_PREFIX}/${sessionId}/${snapshotId}`;
	await runGit(repoRoot, ["update-ref", ref, commit]);
	return ref;
}

async function persistSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { targetId: string; tree: string; kind: "baseline" | "post-run"; label?: string },
): Promise<RollbackSnapshotData | undefined> {
	const repoRoot = await getGitRoot(ctx.cwd);
	if (!repoRoot) return undefined;

	const branch = ctx.sessionManager.getBranch(options.targetId);
	const promptPreview = truncate(getLastMessageText(branch, "user"));
	const assistantPreview = truncate(getLastMessageText(branch, "assistant"), 96);
	const snapshotId = randomUUID().slice(0, 8);
	const ref = await createSnapshotRef(repoRoot, options.tree, ctx.sessionManager.getSessionId(), snapshotId);

	const defaultLabel =
		options.kind === "baseline"
			? `before: ${promptPreview ?? assistantPreview ?? options.targetId}`
			: assistantPreview ?? promptPreview ?? `state at ${options.targetId}`;

	const data: RollbackSnapshotData = {
		version: 2,
		snapshotId,
		targetId: options.targetId,
		ref,
		tree: options.tree,
		repoRoot,
		kind: options.kind,
		label: truncate(options.label, 80) ?? truncate(defaultLabel, 80) ?? `${options.kind} ${snapshotId}`,
		promptPreview,
		assistantPreview,
		createdAt: new Date().toISOString(),
	};

	pi.appendEntry(SNAPSHOT_TYPE, data);
	return data;
}

async function listSnapshotRefs(repoRoot: string, sessionId: string): Promise<string[]> {
	const prefix = `${SNAPSHOT_REF_PREFIX}/${sessionId}`;
	const output = await tryGit(repoRoot, ["for-each-ref", "--format=%(refname)", prefix]);
	return output
		?.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0) ?? [];
}

async function garbageCollectSnapshotRefs(ctx: ExtensionContext): Promise<number> {
	const repoRoot = await getGitRoot(ctx.cwd);
	if (!repoRoot) return 0;

	const sessionId = ctx.sessionManager.getSessionId();
	const validRefs = new Set(
		getSnapshotEntries(ctx)
			.filter((snapshot) => snapshot.data.repoRoot === repoRoot)
			.map((snapshot) => snapshot.data.ref),
	);
	const refs = await listSnapshotRefs(repoRoot, sessionId);
	const staleRefs = refs.filter((ref) => !validRefs.has(ref));
	for (const ref of staleRefs) {
		await runGit(repoRoot, ["update-ref", "-d", ref]);
	}
	return staleRefs.length;
}

async function diffTrees(repoRoot: string, fromTree: string, toTree: string): Promise<string[]> {
	if (fromTree === toTree) return [];
	const output = await runGit(repoRoot, ["diff-tree", "-r", "--no-commit-id", "--name-status", fromTree, toTree]);
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function summarizeDiff(lines: string[], maxLines = 12): string | undefined {
	if (lines.length === 0) return undefined;
	const shown = lines.slice(0, maxLines);
	const more = lines.length > maxLines ? [`…and ${lines.length - maxLines} more change(s)`] : [];
	return [...shown, ...more].join("\n");
}

async function restoreSnapshot(repoRoot: string, ref: string): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-rollback-restore-"));
	const tempIndex = join(tempDir, "index");

	try {
		await runGit(repoRoot, ["read-tree", "--reset", ref], { GIT_INDEX_FILE: tempIndex });
		const snapshotFiles = new Set(
			splitNull(await runGit(repoRoot, ["ls-files", "--cached", "-z"], { GIT_INDEX_FILE: tempIndex })),
		);
		const currentFiles = splitNull(await runGit(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
		const filesToDelete = currentFiles
			.filter((file) => !snapshotFiles.has(file))
			.sort((a, b) => b.length - a.length);

		for (const file of filesToDelete) {
			await rm(resolveInside(repoRoot, file), { recursive: true, force: true });
		}

		await runGit(repoRoot, ["checkout-index", "-a", "-f"], { GIT_INDEX_FILE: tempIndex });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function isExactConversationRestorePoint(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function describeEntry(entry: SessionEntry): { label: string; preview: string } | undefined {
	if (entry.type === "message") {
		if (entry.message.role !== "assistant") return undefined;
		const preview = truncate(extractText(entry.message.content), 90) ?? "(empty)";
		return {
			label: "assistant",
			preview,
		};
	}

	return undefined;
}

function collectRestorePoints(ctx: ExtensionCommandContext): RestorePoint[] {
	const points: RestorePoint[] = [];
	const snapshots = getSnapshotEntries(ctx);
	const exactSnapshotIds = new Set(snapshots.map((snapshot) => snapshot.data.targetId));

	function walk(nodes: SessionTreeNode[], depth: number): void {
		for (const node of nodes) {
			const description = describeEntry(node.entry);
			if (description) {
				const resolvedSnapshot = getResolvedSnapshot(ctx, node.entry.id);
				const labelSuffix = node.label ? ` [${node.label}]` : "";
				points.push({
					entryId: node.entry.id,
					depth,
					timestamp: node.entry.timestamp,
					label: `${description.label}${labelSuffix}`,
					preview: description.preview,
					exactSnapshot: exactSnapshotIds.has(node.entry.id),
					hasSnapshot: !!resolvedSnapshot,
					resolvedSnapshot,
				});
			}
			walk(node.children, depth + 1);
		}
	}

	walk(ctx.sessionManager.getTree(), 0);

	return points.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function formatRestorePoint(point: RestorePoint, index: number): string {
	const marker = point.exactSnapshot ? "◆" : point.hasSnapshot ? "◇" : "·";
	const indent = "  ".repeat(Math.min(point.depth, 6));
	const time = new Date(point.timestamp).toLocaleString();
	return `${index + 1}. ${marker} ${indent}${point.label}: ${point.preview} (${time})`;
}

async function pickRestorePoint(args: string, ctx: ExtensionCommandContext): Promise<RestorePoint | undefined> {
	const points = collectRestorePoints(ctx);
	if (points.length === 0) {
		ctx.ui.notify("No restorable conversation points found", "warning");
		return undefined;
	}

	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		const numericIndex = Number.parseInt(trimmedArgs, 10);
		if (Number.isFinite(numericIndex) && numericIndex >= 1 && numericIndex <= points.length) {
			return points[numericIndex - 1];
		}

		const lower = trimmedArgs.toLowerCase();
		const match = points.find((point) => {
			const haystack = `${point.label} ${point.preview}`.toLowerCase();
			return haystack.includes(lower) || point.entryId === trimmedArgs;
		});
		if (match) return match;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("Pass a restore point number or entry id when no UI is available", "warning");
		return undefined;
	}

	const options = points.map((point, index) => formatRestorePoint(point, index));
	const selected = await ctx.ui.select("Pick restore point", options);
	if (!selected) return undefined;

	const selectedIndex = options.indexOf(selected);
	return selectedIndex >= 0 ? points[selectedIndex] : undefined;
}

async function applySnapshotForTarget(
	targetId: string,
	ctx: ExtensionContext,
): Promise<{ restoredCode: boolean; pointPreview?: string }> {
	const targetEntry = ctx.sessionManager.getEntry(targetId);
	if (!targetEntry) {
		throw new Error("Selected restore point no longer exists");
	}

	const snapshot = getResolvedSnapshot(ctx, targetId);
	const repoRoot = snapshot ? ((await getGitRoot(ctx.cwd)) ?? snapshot.data.repoRoot) : await getGitRoot(ctx.cwd);
	const preview = describeEntry(targetEntry)?.preview;

	if (snapshot && repoRoot) {
		await restoreSnapshot(repoRoot, snapshot.data.ref);
		return { restoredCode: true, pointPreview: preview };
	}

	return { restoredCode: false, pointPreview: preview };
}

async function restoreToPoint(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const point = await pickRestorePoint(args, ctx);
	if (!point) return;

	const snapshot = point.resolvedSnapshot;
	const repoRoot = snapshot ? ((await getGitRoot(ctx.cwd)) ?? snapshot.data.repoRoot) : await getGitRoot(ctx.cwd);
	const targetEntry = ctx.sessionManager.getEntry(point.entryId);
	const diffSummary =
		snapshot && repoRoot
			? summarizeDiff(await diffTrees(repoRoot, snapshot.data.tree, await buildWorkingTree(repoRoot)))
			: undefined;
	if (!targetEntry) {
		ctx.ui.notify("Selected restore point no longer exists", "error");
		return;
	}

	let mode: RestoreMode = snapshot ? "both" : "conversation";

	if (ctx.hasUI) {
		const details = [
			`${point.label}: ${point.preview}`,
			`Selected: ${new Date(point.timestamp).toLocaleString()}`,
			snapshot
				? `Code snapshot: ${point.exactSnapshot ? "exact" : "nearest earlier"}`
				: "Code snapshot: none available",
			snapshot ? `Snapshot created: ${new Date(snapshot.timestamp).toLocaleString()}` : undefined,
			repoRoot ? `Repository: ${repoRoot}` : undefined,
			diffSummary ? "" : undefined,
			diffSummary ? `Changes to be restored:\n${diffSummary}` : undefined,
		]
			.filter(Boolean)
			.join("\n");

		const options = snapshot
			? [
				"Restore code + conversation",
				"Restore conversation only",
				"Restore code only",
				"Cancel",
			]
			: ["Restore conversation only", "Cancel"];
		const choice = await ctx.ui.select(`Choose restore mode\n\n${details}`, options);
		if (!choice || choice === "Cancel") {
			ctx.ui.notify("Restore cancelled", "info");
			return;
		}
		if (choice === "Restore conversation only") mode = "conversation";
		else if (choice === "Restore code only") mode = "code";
		else mode = "both";
	}

	let restoredCode = false;
	if (mode === "both" || mode === "conversation") {
		if (!isExactConversationRestorePoint(targetEntry)) {
			ctx.ui.notify("This restore point cannot restore conversation exactly", "warning");
			return;
		}
		if (ctx.sessionManager.getLeafId() !== point.entryId) {
			const result = await ctx.navigateTree(point.entryId, { summarize: false });
			if (result.cancelled) {
				ctx.ui.notify("Conversation restore was cancelled", "warning");
				return;
			}
		}
	}

	if (mode === "both" || mode === "code") {
		const result = await applySnapshotForTarget(point.entryId, ctx);
		restoredCode = result.restoredCode;
		if (!restoredCode && mode === "code") {
			ctx.ui.notify("No saved code snapshot exists for this point", "warning");
			return;
		}
	}

	if (mode === "both") {
		ctx.ui.notify(`Restored code + conversation: ${point.preview}`, "info");
	} else if (mode === "code") {
		ctx.ui.notify(
			restoredCode ? `Restored code only: ${point.preview}` : "No saved code snapshot exists for this point",
			restoredCode ? "info" : "warning",
		);
	} else {
		ctx.ui.notify(`Restored conversation only: ${point.preview}`, "info");
	}
}

export default function rollbackExtension(pi: ExtensionAPI) {

	pi.registerCommand("restore", {
		description: "Restore code + conversation to any prior point",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				await restoreToPoint(args, ctx);
			} catch (error) {
				ctx.ui.notify(`Restore failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("rollback", {
		description: "Alias for /restore",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				await restoreToPoint(args, ctx);
			} catch (error) {
				ctx.ui.notify(`Restore failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("rollback-gc", {
		description: "Remove stale rollback snapshot refs for the current session",
		handler: async (_args, ctx) => {
			try {
				await ctx.waitForIdle();
				const removed = await garbageCollectSnapshotRefs(ctx);
				ctx.ui.notify(
					removed > 0 ? `Removed ${removed} stale rollback snapshot ref(s)` : "No stale rollback snapshot refs found",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Rollback GC failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const removed = await garbageCollectSnapshotRefs(ctx);
			if (removed > 0 && ctx.hasUI) {
				ctx.ui.notify(`Cleaned up ${removed} stale rollback snapshot ref(s)`, "info");
			}
		} catch {
			// Ignore GC failures during startup
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		try {
			const repoRoot = await getGitRoot(ctx.cwd);
			const targetId = ctx.sessionManager.getLeafId();
			if (!repoRoot || !targetId) return;
			if (getExactSnapshot(ctx, targetId)) return;

			const tree = await buildWorkingTree(repoRoot);
			const resolvedSnapshot = getResolvedSnapshot(ctx, targetId);
			if (resolvedSnapshot?.data.tree === tree) return;
			await persistSnapshot(pi, ctx, { targetId, tree, kind: "baseline" });
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Rollback baseline snapshot failed: ${(error as Error).message}`, "warning");
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		try {
			const repoRoot = await getGitRoot(ctx.cwd);
			const targetId = ctx.sessionManager.getLeafId();
			if (!repoRoot || !targetId) return;

			const tree = await buildWorkingTree(repoRoot);
			const previousSnapshot = getResolvedSnapshot(ctx, targetId);
			if (previousSnapshot?.data.tree === tree) return;

			await persistSnapshot(pi, ctx, { targetId, tree, kind: "post-run" });
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Rollback snapshot failed: ${(error as Error).message}`, "warning");
			}
		}
	});
}

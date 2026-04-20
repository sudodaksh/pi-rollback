/**
 * Rollback Extension
 *
 * Claude Code-style restore for pi:
 * - automatically snapshots workspace state when code changes
 * - can restore conversation to any prior user prompt boundary
 * - can restore code, conversation, or both
 * - undo last restore to recover pre-restore state
 *
 * Design:
 * - baseline snapshot is captured for the first prompt in a session branch
 * - after each completed agent run, a new snapshot is saved only if the
 *   workspace tree changed
 * - restore points include both "before prompt" and "after prompt" boundaries
 *   so you can restore either side of a completed run
 * - every saved post-run snapshot is exposed as an "after prompt" restore point
 * - if a prompt did not create a new snapshot, the extension uses the nearest
 *   earlier snapshot on that branch path
 * - before restoring code, the current state is saved so it can be undone
 *
 * Requirements:
 * - Must be inside a git repository
 * - Snapshots include tracked + untracked non-ignored files
 * - Ignored files are preserved on restore
 *
 * Commands:
 * - /restore        Restore code + conversation to a prompt boundary
 * - /rollback       Alias for /restore
 * - /undo-restore   Undo the last code restore
 * - /rollback-gc    Remove stale snapshot refs for the current session
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";

const SNAPSHOT_TYPE = "rollback-snapshot";
const RESTORE_EVENT_TYPE = "rollback-restore-event";
const SNAPSHOT_REF_PREFIX = "refs/pi/rollback";
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "pi rollback",
	GIT_AUTHOR_EMAIL: "pi@localhost",
	GIT_COMMITTER_NAME: "pi rollback",
	GIT_COMMITTER_EMAIL: "pi@localhost",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface RestoreEventData {
	version: 2;
	restoreEventId: string;
	preRestoreTree: string;
	preRestoreRef: string;
	restoredToEntryId: string;
	restoredToSnapshotRef?: string;
	mode: RestoreMode;
	kind: "restore" | "undo-restore";
	repoRoot: string;
	createdAt: string;
}

interface RestoreEvent {
	entryId: string;
	timestamp: string;
	data: RestoreEventData;
}

interface RestorePoint {
	kind: "before-prompt" | "after-prompt";
	entryId: string;
	depth: number;
	timestamp: string;
	label: string;
	branchLabel?: string;
	preview: string;
	exactSnapshot: boolean;
	hasSnapshot: boolean;
	resolvedSnapshot?: RollbackSnapshot;
}

interface PromptGroup {
	userEntryId: string;
	preview: string;
	timestamp: string;
	branchLabel?: string;
	depth: number;
	beforePoint: RestorePoint;
	afterPoint?: RestorePoint;
}

type RestoreMode = "both" | "conversation" | "code";

interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

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

function getEntryMessageText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const message = entry.message as { role?: string; content?: unknown };
	return extractText(message.content);
}

function getLastMessageText(entries: SessionEntry[], role: "user" | "assistant"): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== role) continue;
		const text = getEntryMessageText(entry);
		if (text.trim()) return text;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

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

function isRestoreEventData(data: unknown): data is RestoreEventData {
	if (!data || typeof data !== "object") return false;
	const event = data as Partial<RestoreEventData>;
	return (
		event.version === 2 &&
		typeof event.restoreEventId === "string" &&
		typeof event.preRestoreTree === "string" &&
		typeof event.preRestoreRef === "string" &&
		typeof event.restoredToEntryId === "string" &&
		(event.kind === "restore" || event.kind === "undo-restore") &&
		typeof event.repoRoot === "string" &&
		typeof event.createdAt === "string"
	);
}

// ---------------------------------------------------------------------------
// Snapshot & restore event queries
// ---------------------------------------------------------------------------

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

function getRestoreEventEntries(ctx: ExtensionContext): RestoreEvent[] {
	return ctx.sessionManager
		.getEntries()
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.flatMap((entry) => {
			if (entry.customType !== RESTORE_EVENT_TYPE || !isRestoreEventData(entry.data)) return [];
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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveInside(repoRoot: string, relativePath: string): string {
	const target = resolve(repoRoot, relativePath);
	const normalizedRoot = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
	if (target !== repoRoot && !target.startsWith(normalizedRoot)) {
		throw new Error(`Refusing to operate outside repository root: ${relativePath}`);
	}
	return target;
}

// ---------------------------------------------------------------------------
// Git tree operations
// ---------------------------------------------------------------------------

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
	const commit = (
		await runGit(
			repoRoot,
			["commit-tree", tree, "-m", `pi rollback snapshot ${snapshotId}`],
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
			? `before prompt: ${promptPreview ?? assistantPreview ?? options.targetId}`
			: `after run: ${assistantPreview ?? promptPreview ?? options.targetId}`;

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
	const restoreRefs = new Set(
		getRestoreEventEntries(ctx)
			.filter((event) => event.data.repoRoot === repoRoot)
			.map((event) => event.data.preRestoreRef),
	);
	const refs = await listSnapshotRefs(repoRoot, sessionId);
	const staleRefs = refs.filter((ref) => !validRefs.has(ref) && !restoreRefs.has(ref));
	for (const ref of staleRefs) {
		await runGit(repoRoot, ["update-ref", "-d", ref]);
	}
	return staleRefs.length;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Restore operations
// ---------------------------------------------------------------------------

async function removeEmptyParents(repoRoot: string, filePaths: string[]): Promise<void> {
	const normalRoot = repoRoot.endsWith(sep) ? repoRoot.slice(0, -1) : repoRoot;
	const dirs = new Set<string>();
	for (const file of filePaths) {
		let dir = dirname(resolveInside(repoRoot, file));
		while (dir !== normalRoot && dir.startsWith(normalRoot + sep)) {
			dirs.add(dir);
			dir = dirname(dir);
		}
	}
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		try {
			await rmdir(dir);
		} catch {
			// not empty or already removed
		}
	}
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

		await Promise.all(
			filesToDelete.map((file) => rm(resolveInside(repoRoot, file), { recursive: true, force: true })),
		);
		await removeEmptyParents(repoRoot, filesToDelete);

		await runGit(repoRoot, ["checkout-index", "-a", "-f"], { GIT_INDEX_FILE: tempIndex });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Restore point helpers
// ---------------------------------------------------------------------------

function isUserRestorePoint(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message" && entry.message.role === "user";
}

function isAssistantRestorePoint(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isExactConversationRestorePoint(entry: SessionEntry): boolean {
	return isUserRestorePoint(entry) || isAssistantRestorePoint(entry);
}

function describeEntry(entry: SessionEntry): { label: string; preview: string } | undefined {
	if (!isUserRestorePoint(entry)) return undefined;
	const preview = truncate(getEntryMessageText(entry), 90) ?? "(empty prompt)";
	return {
		label: "before prompt",
		preview,
	};
}

function getAfterPromptDescription(ctx: ExtensionContext, snapshot: RollbackSnapshot): { label: string; preview: string } {
	const preview =
		truncate(snapshot.data.promptPreview, 90) ??
		truncate(getLastMessageText(ctx.sessionManager.getBranch(snapshot.data.targetId), "user"), 90) ??
		"(unknown prompt)";
	return {
		label: "after prompt",
		preview,
	};
}

function getAfterRestorePoints(ctx: ExtensionCommandContext): RestorePoint[] {
	return getSnapshotEntries(ctx)
		.filter((snapshot) => snapshot.data.kind === "post-run")
		.flatMap((snapshot) => {
			const targetEntry = ctx.sessionManager.getEntry(snapshot.data.targetId);
			if (!targetEntry || !isAssistantRestorePoint(targetEntry)) return [];

			const afterDescription = getAfterPromptDescription(ctx, snapshot);
			return [
				{
					kind: "after-prompt" as const,
					entryId: snapshot.data.targetId,
					depth: 0,
					timestamp: snapshot.timestamp,
					label: afterDescription.label,
					branchLabel: ctx.sessionManager.getLabel(snapshot.data.targetId),
					preview: afterDescription.preview,
					exactSnapshot: true,
					hasSnapshot: true,
					resolvedSnapshot: snapshot,
				},
			];
		});
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
				points.push({
					kind: "before-prompt",
					entryId: node.entry.id,
					depth,
					timestamp: node.entry.timestamp,
					label: description.label,
					branchLabel: node.label,
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
	points.push(...getAfterRestorePoints(ctx));
	return points.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function collectPromptGroups(ctx: ExtensionCommandContext): PromptGroup[] {
	const allPoints = collectRestorePoints(ctx);

	const beforeByEntry = new Map<string, RestorePoint>();
	const afterByUserEntry = new Map<string, RestorePoint>();

	for (const point of allPoints) {
		if (point.kind === "before-prompt") {
			beforeByEntry.set(point.entryId, point);
		} else {
			const branch = ctx.sessionManager.getBranch(point.entryId);
			for (let i = branch.length - 2; i >= 0; i--) {
				if (isUserRestorePoint(branch[i])) {
					afterByUserEntry.set(branch[i].id, point);
					break;
				}
			}
		}
	}

	const groups: PromptGroup[] = [];
	for (const [userId, beforePoint] of beforeByEntry) {
		groups.push({
			userEntryId: userId,
			preview: beforePoint.preview,
			timestamp: beforePoint.timestamp,
			branchLabel: beforePoint.branchLabel,
			depth: beforePoint.depth,
			beforePoint,
			afterPoint: afterByUserEntry.get(userId),
		});
	}

	return groups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function formatPromptGroup(group: PromptGroup, index: number): string {
	const time = new Date(group.timestamp).toLocaleString();
	const branch = group.branchLabel ? ` [${group.branchLabel}]` : "";
	const hasCode = group.beforePoint.hasSnapshot || group.afterPoint?.hasSnapshot;
	const suffix = hasCode ? "" : " — conversation only";
	return `${index + 1}. ${group.preview}${branch}${suffix} (${time})`;
}

async function pickRestorePoint(args: string, ctx: ExtensionCommandContext): Promise<RestorePoint | undefined> {
	const groups = collectPromptGroups(ctx);
	if (groups.length === 0) {
		ctx.ui.notify("No restorable prompts found", "warning");
		return undefined;
	}

	let selectedGroup: PromptGroup | undefined;

	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		const numericIndex = Number.parseInt(trimmedArgs, 10);
		if (Number.isFinite(numericIndex) && numericIndex >= 1 && numericIndex <= groups.length) {
			selectedGroup = groups[numericIndex - 1];
		} else {
			const lower = trimmedArgs.toLowerCase();
			selectedGroup = groups.find((group) => {
				const haystack = `${group.preview} ${group.branchLabel ?? ""}`.toLowerCase();
				return haystack.includes(lower) || group.userEntryId === trimmedArgs;
			});
		}
	}

	if (!selectedGroup) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				trimmedArgs ? "No matching restore point found" : "Pass a restore point number or search term when no UI is available",
				"warning",
			);
			return undefined;
		}

		const options = groups.map((group, index) => formatPromptGroup(group, index));
		const selected = await ctx.ui.select("Pick a prompt to restore", options);
		if (!selected) return undefined;

		const selectedIndex = options.indexOf(selected);
		if (selectedIndex < 0) return undefined;
		selectedGroup = groups[selectedIndex];
	}

	if (selectedGroup.beforePoint && selectedGroup.afterPoint) {
		if (!ctx.hasUI) {
			return selectedGroup.beforePoint;
		}

		const beforeLabel = "Before — just before this prompt ran";
		const afterLabel = "After — the saved end state after this prompt completed";
		const choice = await ctx.ui.select(
			`Restore: ${selectedGroup.preview}`,
			[beforeLabel, afterLabel, "Cancel"],
		);
		if (!choice || choice === "Cancel") return undefined;
		return choice === beforeLabel ? selectedGroup.beforePoint : selectedGroup.afterPoint;
	}

	return selectedGroup.beforePoint ?? selectedGroup.afterPoint;
}

// ---------------------------------------------------------------------------
// Pre-restore state capture
// ---------------------------------------------------------------------------

async function savePreRestoreState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: {
		repoRoot: string;
		currentTree: string;
		restoredToEntryId: string;
		restoredToSnapshotRef?: string;
		mode: RestoreMode;
		kind: "restore" | "undo-restore";
	},
): Promise<RestoreEventData> {
	const restoreEventId = randomUUID().slice(0, 8);
	const ref = await createSnapshotRef(
		options.repoRoot,
		options.currentTree,
		ctx.sessionManager.getSessionId(),
		`restore-${restoreEventId}`,
	);

	const data: RestoreEventData = {
		version: 2,
		restoreEventId,
		preRestoreTree: options.currentTree,
		preRestoreRef: ref,
		restoredToEntryId: options.restoredToEntryId,
		restoredToSnapshotRef: options.restoredToSnapshotRef,
		mode: options.mode,
		kind: options.kind,
		repoRoot: options.repoRoot,
		createdAt: new Date().toISOString(),
	};

	pi.appendEntry(RESTORE_EVENT_TYPE, data);
	return data;
}

// ---------------------------------------------------------------------------
// Core restore logic
// ---------------------------------------------------------------------------

async function restoreToPoint(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const repoRoot = await getGitRoot(ctx.cwd);
	if (!repoRoot) {
		ctx.ui.notify("Not inside a git repository — restore requires git", "warning");
		return;
	}

	const point = await pickRestorePoint(args, ctx);
	if (!point) return;

	const snapshot = point.resolvedSnapshot;
	const targetEntry = ctx.sessionManager.getEntry(point.entryId);
	if (!targetEntry) {
		ctx.ui.notify("Selected restore point no longer exists", "error");
		return;
	}

	let currentTree: string | undefined;
	if (snapshot) {
		currentTree = await buildWorkingTree(repoRoot);
	}

	const isAfterPrompt = point.kind === "after-prompt";
	let mode: RestoreMode = snapshot ? "both" : "conversation";

	if (ctx.hasUI) {
		const diffSummary =
			currentTree && snapshot
				? summarizeDiff(await diffTrees(repoRoot, snapshot.data.tree, currentTree))
				: undefined;

		const details = [
			`Prompt: ${point.preview}`,
			isAfterPrompt ? "Restore target: just after this prompt completed" : "Restore target: just before this prompt ran",
			isAfterPrompt
				? "Conversation restore: restores the completed response after this prompt"
				: "Conversation restore: rewinds here and puts this prompt back in the editor",
			snapshot
				? `Code restore: ${isAfterPrompt ? "uses the exact snapshot taken after this run" : point.exactSnapshot ? "uses the exact snapshot taken before this prompt" : "uses the nearest earlier snapshot on this branch"}`
				: "Code restore: not available for this prompt",
			`Selected: ${new Date(point.timestamp).toLocaleString()}`,
			snapshot ? `Snapshot created: ${new Date(snapshot.timestamp).toLocaleString()}` : undefined,
			`Repository: ${repoRoot}`,
			diffSummary ? "" : undefined,
			diffSummary ? `Files that will be reverted:\n${diffSummary}` : snapshot ? "Files that will be reverted: none" : undefined,
		]
			.filter(Boolean)
			.join("\n");

		const bothOption = isAfterPrompt
			? "Restore code + conversation (restore to after this prompt)"
			: "Restore code + conversation (rewind to before this prompt)";
		const conversationOption = isAfterPrompt
			? "Restore conversation only (show the completed response after this prompt)"
			: "Restore conversation only (rewind and put prompt back in editor)";
		const codeOption = "Restore code only (revert files only)";
		const options = snapshot ? [bothOption, conversationOption, codeOption, "Cancel"] : [conversationOption, "Cancel"];
		const choice = await ctx.ui.select(`Choose restore mode\n\n${details}`, options);
		if (!choice || choice === "Cancel") {
			ctx.ui.notify("Restore cancelled", "info");
			return;
		}
		if (choice === conversationOption) mode = "conversation";
		else if (choice === codeOption) mode = "code";
		else mode = "both";
	}

	if (mode === "both" || mode === "conversation") {
		if (!isExactConversationRestorePoint(targetEntry)) {
			ctx.ui.notify("Only completed assistant responses and user prompts can restore conversation exactly", "warning");
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

	let restoredCode = false;
	if (mode === "both" || mode === "code") {
		if (!snapshot) {
			if (mode === "code") {
				ctx.ui.notify("No saved code snapshot exists for this point", "warning");
				return;
			}
		} else {
			if (!currentTree) currentTree = await buildWorkingTree(repoRoot);
			await savePreRestoreState(pi, ctx, {
				repoRoot,
				currentTree,
				restoredToEntryId: point.entryId,
				restoredToSnapshotRef: snapshot.data.ref,
				mode,
				kind: "restore",
			});
			await restoreSnapshot(repoRoot, snapshot.data.ref);
			restoredCode = true;
		}
	}

	if (mode === "both") {
		ctx.ui.notify(isAfterPrompt ? `Restored to after prompt: ${point.preview}` : `Restored to before prompt: ${point.preview}`, "info");
	} else if (mode === "code") {
		ctx.ui.notify(
			restoredCode
				? isAfterPrompt
					? `Restored code only to after prompt: ${point.preview}`
					: `Restored code only to before prompt: ${point.preview}`
				: "No saved code snapshot exists for this point",
			restoredCode ? "info" : "warning",
		);
	} else {
		ctx.ui.notify(
			isAfterPrompt
				? `Restored conversation only to after prompt: ${point.preview}`
				: `Restored conversation only to before prompt: ${point.preview}`,
			"info",
		);
	}
}

// ---------------------------------------------------------------------------
// Undo restore
// ---------------------------------------------------------------------------

async function undoLastRestore(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const repoRoot = await getGitRoot(ctx.cwd);
	if (!repoRoot) throw new Error("Not inside a git repository — undo-restore requires git");

	const events = getRestoreEventEntries(ctx);
	const lastRestore = events.filter((e) => e.data.kind === "restore").at(-1);
	if (!lastRestore) return false;
	const currentTree = await buildWorkingTree(repoRoot);

	await savePreRestoreState(pi, ctx, {
		repoRoot,
		currentTree,
		restoredToEntryId: lastRestore.data.restoredToEntryId,
		mode: "code",
		kind: "undo-restore",
	});

	await restoreSnapshot(repoRoot, lastRestore.data.preRestoreRef);
	return true;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function rollbackExtension(pi: ExtensionAPI) {

	pi.registerCommand("restore", {
		description: "Restore code + conversation to a prompt boundary",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				await restoreToPoint(args, ctx, pi);
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
				await restoreToPoint(args, ctx, pi);
			} catch (error) {
				ctx.ui.notify(`Restore failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("undo-restore", {
		description: "Undo the last code restore",
		handler: async (_args, ctx) => {
			try {
				await ctx.waitForIdle();
				const undone = await undoLastRestore(pi, ctx);
				ctx.ui.notify(
					undone ? "Undo restore complete — working tree recovered" : "No restore to undo",
					undone ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(`Undo restore failed: ${(error as Error).message}`, "error");
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

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------

export const __testing__ = {
	buildWorkingTree,
	createSnapshotRef,
	persistSnapshot,
	restoreSnapshot,
	getSnapshotEntries,
	getRestoreEventEntries,
	getResolvedSnapshot,
	getExactSnapshot,
	savePreRestoreState,
	undoLastRestore,
	getGitRoot,
	runGit,
	GIT_IDENTITY,
};

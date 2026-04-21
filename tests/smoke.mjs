import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __testing__ } = await import("../index.ts");
const {
	buildWorkingTree,
	persistSnapshot,
	restoreSnapshot,
	getSnapshotEntries,
	getRestoreEventEntries,
	getResolvedSnapshot,
	savePreRestoreState,
	undoLastRestore,
	restoreToPoint,
} = __testing__;

function exec(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
			if ((code ?? 0) !== 0) {
				reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code}`));
				return;
			}
			resolve({ stdout, stderr, code: code ?? 0 });
		});
	});
}

class SessionHarness {
	constructor() {
		this.entries = [];
		this.byId = new Map();
		this.leafId = null;
		this.sessionId = "test-session";
		this.nextId = 1;
	}

	makeId() {
		return `e${this.nextId++}`;
	}

	appendMessage(role, text) {
		const entry = {
			type: "message",
			id: this.makeId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message: {
				role,
				content: [{ type: "text", text }],
			},
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		return entry.id;
	}

	appendCustomEntry(customType, data) {
		const entry = {
			type: "custom",
			id: this.makeId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		return entry.id;
	}

	getEntries() {
		return [...this.entries];
	}

	getEntry(id) {
		return id ? this.byId.get(id) : undefined;
	}

	getLeafId() {
		return this.leafId;
	}

	getSessionId() {
		return this.sessionId;
	}

	getLabel() {
		return undefined;
	}

	getBranch(targetId) {
		const branch = [];
		let current = this.getEntry(targetId);
		while (current) {
			branch.unshift(current);
			current = current.parentId ? this.getEntry(current.parentId) : undefined;
		}
		return branch;
	}

	getTree() {
		const byParent = new Map();
		for (const entry of this.entries) {
			const key = entry.parentId ?? null;
			const nodes = byParent.get(key) ?? [];
			nodes.push({ entry, children: [], label: undefined, labelTimestamp: undefined });
			byParent.set(key, nodes);
		}

		function attach(parentId) {
			const nodes = byParent.get(parentId ?? null) ?? [];
			for (const node of nodes) {
				node.children = attach(node.entry.id);
			}
			return nodes;
		}

		return attach(null);
	}
}

function createPi(session) {
	return {
		appendEntry(customType, data) {
			session.appendCustomEntry(customType, data);
		},
	};
}

function createContext(session, cwd) {
	return {
		hasUI: false,
		cwd,
		sessionManager: session,
		ui: {
			notify() {},
		},
	};
}

function createCommandContext(session, cwd) {
	return {
		...createContext(session, cwd),
		navigateTree: async (targetId) => {
			session.leafId = targetId;
			return { cancelled: false };
		},
	};
}

async function main() {
	const repoRoot = await mkdtemp(join(tmpdir(), "pi-rollback-smoke-"));

	try {
		await exec("git", ["init"], repoRoot);
		await exec("git", ["config", "user.name", "pi rollback smoke"], repoRoot);
		await exec("git", ["config", "user.email", "pi-rollback-smoke@example.com"], repoRoot);

		const notePath = join(repoRoot, "note.txt");
		await writeFile(notePath, "base\n");
		await exec("git", ["add", "note.txt"], repoRoot);
		await exec("git", ["commit", "-m", "initial"], repoRoot);

		const session = new SessionHarness();
		const pi = createPi(session);
		const ctx = createContext(session, repoRoot);
		const commandCtx = createCommandContext(session, repoRoot);

		// --- First prompt: simulate agent_start -> file change -> agent_end ---

		const user1Id = session.appendMessage("user", "update note.txt");

		// agent_start: capture baseline
		const baselineTree = await buildWorkingTree(repoRoot);
		await persistSnapshot(pi, ctx, { targetId: user1Id, tree: baselineTree, kind: "baseline" });

		// simulate file change
		await writeFile(notePath, "changed\n");

		const assistant1Id = session.appendMessage("assistant", "Updated note.txt.");

		// agent_end: capture post-run
		const postRunTree = await buildWorkingTree(repoRoot);
		assert.notEqual(baselineTree, postRunTree, "trees should differ after file change");
		await persistSnapshot(pi, ctx, { targetId: assistant1Id, tree: postRunTree, kind: "post-run" });

		// Verify snapshots
		const snapshots = getSnapshotEntries(ctx);
		assert.equal(snapshots.length, 2, "should have baseline + post-run snapshots");
		assert.equal(snapshots[0].data.kind, "baseline");
		assert.equal(snapshots[1].data.kind, "post-run");

		// Verify resolved snapshot for user prompt
		const resolved = getResolvedSnapshot(ctx, user1Id);
		assert.ok(resolved, "user prompt should resolve to a snapshot");
		assert.equal(resolved.data.kind, "baseline", "should resolve to the baseline snapshot");

		// --- Make more changes, then restore to before first prompt ---

		await writeFile(notePath, "later\n");
		await exec("git", ["add", "note.txt"], repoRoot);

		// Capture pre-restore state and restore
		const preRestoreTree = await buildWorkingTree(repoRoot);
		await savePreRestoreState(pi, ctx, {
			repoRoot,
			currentTree: preRestoreTree,
			restoredToEntryId: user1Id,
			restoredToSnapshotRef: resolved.data.ref,
			mode: "code",
			kind: "restore",
		});
		await restoreSnapshot(repoRoot, resolved.data.ref);

		assert.equal(await readFile(notePath, "utf8"), "base\n", "restore should revert to before-prompt state");

		// Verify staged/index state is untouched
		const stagedAfterRestore = (await exec("git", ["diff", "--cached", "--name-only"], repoRoot)).stdout.trim().split("\n").filter(Boolean);
		assert.deepEqual(stagedAfterRestore, ["note.txt"], "restore should leave staged/index state untouched");

		// Verify restore event was recorded
		const restoreEvents = getRestoreEventEntries(ctx);
		assert.equal(restoreEvents.length, 1, "should have one restore event");
		assert.equal(restoreEvents[0].data.kind, "restore");
		assert.equal(restoreEvents[0].data.preRestoreTree, preRestoreTree);

		// --- Undo the restore ---

		await undoLastRestore(pi, ctx);

		assert.equal(await readFile(notePath, "utf8"), "later\n", "undo should recover pre-restore state");

		// Verify staged/index state is still untouched
		const stagedAfterUndo = (await exec("git", ["diff", "--cached", "--name-only"], repoRoot)).stdout.trim().split("\n").filter(Boolean);
		assert.deepEqual(stagedAfterUndo, ["note.txt"], "undo-restore should also leave staged/index state untouched");

		// Verify undo event was recorded
		const allEvents = getRestoreEventEntries(ctx);
		assert.equal(allEvents.length, 2, "should have restore + undo events");
		assert.equal(allEvents[1].data.kind, "undo-restore");

		// --- Restore should also move the session leaf, and undo should move it back ---

		const user2RestoreId = session.appendMessage("user", "make it later again");
		await writeFile(notePath, "latest\n");
		const latestTree = await buildWorkingTree(repoRoot);
		await persistSnapshot(pi, ctx, { targetId: user2RestoreId, tree: latestTree, kind: "baseline" });
		const assistant2RestoreId = session.appendMessage("assistant", "Updated note.txt again.");
		const latestPostRunTree = await buildWorkingTree(repoRoot);
		await persistSnapshot(pi, ctx, { targetId: assistant2RestoreId, tree: latestPostRunTree, kind: "post-run" });

		const user3CurrentId = session.appendMessage("user", "continue from here");
		assert.equal(session.getLeafId(), user3CurrentId, "sanity check: current leaf should be latest prompt");

		await restoreToPoint(user1Id, commandCtx, pi);

		const restoreEventsAfterCommand = getRestoreEventEntries(ctx);
		const lastRestoreEvent = restoreEventsAfterCommand.at(-1);
		assert.equal(lastRestoreEvent?.data.kind, "restore", "restoreToPoint should record a restore event");
		assert.equal(lastRestoreEvent?.data.preRestoreEntryId, user3CurrentId, "restore should remember the pre-restore session leaf");
		assert.equal(session.getLeafId(), user1Id, "restoreToPoint should rewind the session leaf to the selected prompt");
		assert.equal(await readFile(notePath, "utf8"), "base\n", "restoreToPoint should also restore code to the selected prompt state");

		await undoLastRestore(pi, commandCtx);

		assert.equal(session.getLeafId(), user3CurrentId, "undoLastRestore should restore the previous session leaf");
		assert.equal(await readFile(notePath, "utf8"), "latest\n", "undoLastRestore should restore the pre-restore working tree");

		// --- Second prompt: no code changes ---

		const user2Id = session.appendMessage("user", "explain the changes");
		const noChangeTree = await buildWorkingTree(repoRoot);
		await persistSnapshot(pi, ctx, { targetId: user2Id, tree: noChangeTree, kind: "baseline" });

		session.appendMessage("assistant", "No code changes needed.");

		// agent_end: tree unchanged, so in the real extension this would be skipped
		const stillSameTree = await buildWorkingTree(repoRoot);
		assert.equal(noChangeTree, stillSameTree, "trees should match when no files changed");

		// Verify total snapshot count
		const finalSnapshots = getSnapshotEntries(ctx);
		assert.equal(finalSnapshots.length, 5, "should have 5 snapshots after the added restore/undo coverage");

		console.log("pi-code-rollback smoke test passed");
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
}

await main();

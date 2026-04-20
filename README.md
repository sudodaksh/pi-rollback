# pi-rollback

Git-backed restore for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

`pi-rollback` automatically snapshots your workspace as you work, then lets you restore either:
- the conversation,
- the code,
- or both.

The restore UX is built around **prompt boundaries**, which makes it much easier to understand what you are restoring.

## Install in pi

### Install from GitHub for all projects

```bash
pi install https://github.com/sudodaksh/pi-rollback.git
```

This writes to your global pi settings, so the extension is available in every repo.

### Install only for the current project

```bash
pi install -l https://github.com/sudodaksh/pi-rollback.git
```

This writes to `.pi/settings.json` in the current project.

### Try it without installing

```bash
pi -e https://github.com/sudodaksh/pi-rollback.git
```

This loads the extension for the current pi run only.

### Install from a local checkout

From this repository root:

```bash
pi install .
```

Or with an absolute path:

```bash
pi install /absolute/path/to/pi-rollback
```

For one-off local testing:

```bash
pi -e .
```

### Verify it is installed

Start pi inside a git repository and run:

```text
/restore
```

You should see the restore picker listing your prompts.

## What gets saved

During a session, the extension saves git-backed snapshots at two useful boundaries:

- **before:** just before a user prompt runs
- **after:** just after a completed run finishes

That means restore points map to how you actually think about work:
- "go back to before I asked for this"
- "go back to the finished result of that run"

## Typical flow

1. Work normally in a **git repository**.
2. Ask pi to make changes.
3. The extension captures:
   - a **baseline** snapshot before a prompt runs
   - a **post-run** snapshot after a completed run, but only if the workspace changed
4. Run `/restore` when you want to go back.
5. Pick a prompt from the list.
6. Choose **before** or **after** that prompt (if both snapshots exist).
7. Pick a restore mode:
   - **code + conversation**
   - **conversation only**
   - **code only**

If you change your mind after restoring, run `/undo-restore` to recover the working tree from before the restore.

## Restore semantics

### Before

This means **just before that prompt ran**.

- **Conversation restore**: rewinds there and puts that prompt back in the editor
- **Code restore**: restores files to the snapshot from before that prompt started

### After

This means **the saved completed state after that prompt finished**.

- **Conversation restore**: restores the completed response after that prompt
- **Code restore**: restores files to the exact post-run snapshot for that completed state

## Example

Say your session looked like this:

1. `a: update README.md`
2. `b: update loop.md`

Running `/restore` and selecting prompt `a`:
- **Before** → restore to the original state before `README.md` changed
- **After** → restore to the finished state after `README.md` changed

Selecting prompt `b`:
- **Before** → restore to the state after `a`, but before `b`
- **After** → restore to the finished state after `b`, including `loop.md`

## Commands

- `/restore` — restore code + conversation to a prompt boundary
- `/rollback` — alias for `/restore`
- `/undo-restore` — undo the last code restore (recovers the working tree from before the restore)
- `/rollback-gc` — remove stale rollback snapshot refs for the current session

## Requirements

- must be inside a git repository
- snapshots include tracked + untracked non-ignored files
- ignored files are preserved on restore

## Notes

- Post-run snapshots are only saved when the workspace actually changes.
- If a prompt does not have its own exact snapshot, restore uses the nearest earlier snapshot on that branch path.
- Before any code restore, the current working tree is saved so it can be undone with `/undo-restore`.
- Snapshots are stored as orphan git commits under `refs/pi/rollback/...`.

## Package manifest

This repository is already structured as a publishable pi package.

### Files used by pi

- `package.json` — npm metadata + pi package manifest
- `index.ts` — the extension entrypoint loaded by pi
- `README.md` — package docs shown on npm/GitHub
- `LICENSE` — required for clean package publishing
- `tsconfig.json` — typecheck config for local validation and prepublish checks

The important manifest is:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Publish this package

After pushing this repo to GitHub and logging into npm:

```bash
npm publish
```

Then users can install it with:

```bash
pi install npm:pi-rollback
```

To validate locally before publishing:

```bash
npm install
npm run check
```

# pi-rollback

Claude Code-style restore for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

Features:
- automatic git-backed snapshots when code changes
- restore points are user prompts, not assistant replies
- restoring a prompt rewinds to just before that prompt ran
- choose restore mode:
  - code + conversation
  - conversation only
  - code only
- rollback snapshot ref cleanup via `/rollback-gc`

## Install

### From a local checkout

```bash
pi install /absolute/path/to/packages/pi-rollback
# or
pi install ./packages/pi-rollback
```

### For one-off testing

```bash
pi -e ./packages/pi-rollback
```

## Usage

Commands:
- `/restore`
- `/rollback` — alias for `/restore`
- `/rollback-gc`

When you run `/restore`, the picker shows prior **user messages**.
Selecting one means:
- **Conversation restore**: jump to just before that prompt and put it back in the editor
- **Code restore**: revert files to the snapshot captured before that prompt started

## Requirements

- must be inside a git repository
- snapshots include tracked + untracked non-ignored files
- ignored files are preserved on restore

## Package manifest

This package is installable by pi because `package.json` contains:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

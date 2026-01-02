# AGENTS.md - Coding Agent Guidelines

## Project Overview

Window Size Tracker is a GNOME Shell Extension for GNOME 49 that tracks window sizes
when applications are resized or closed, and restores them when relaunched.
Wayland-only. Pure JavaScript (ES Modules) with no build step.

## Build/Install Commands

```bash
# Install or update the extension (copies files to ~/.local/share/gnome-shell/extensions/)
./install.sh

# Remove the extension completely
./install.sh --remove

# Show help
./install.sh --help
```

## Versioning

**IMPORTANT:** When making ANY changes to the extension code (`extension.js` or `metadata.json`),
you MUST increment the `"version"` field in `metadata.json`. This is a simple integer that
should be incremented by 1 for each change (e.g., 1 -> 2 -> 3).

```json
{
    "version": 2,
    ...
}
```

## Git Commit Guidelines

**MANDATORY:** All commits MUST:
1. Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification
2. Be signed with GPG or SSH (use `git commit -S`)

### Commit Signing

All commits **MUST** be signed. Use the `-S` flag when committing:

```bash
git commit -S -m "feat: add new feature"
```

To configure automatic signing for this repository:

```bash
git config commit.gpgsign true
```

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                              |
|------------|----------------------------------------------------------|
| `feat`     | A new feature                                            |
| `fix`      | A bug fix                                                |
| `docs`     | Documentation only changes                               |
| `style`    | Code style changes (formatting, whitespace, etc.)        |
| `refactor` | Code change that neither fixes a bug nor adds a feature  |
| `perf`     | Performance improvement                                  |
| `test`     | Adding or updating tests                                 |
| `chore`    | Maintenance tasks (build scripts, dependencies, etc.)    |

### Rules

1. Type and description are **required**
2. Description must be lowercase and not end with a period
3. Use imperative mood in description ("add feature" not "added feature")
4. Body should explain **what** and **why**, not how
5. Breaking changes must include `BREAKING CHANGE:` in footer or `!` after type

### Examples

```bash
# Simple feature
feat: add window position tracking

# Bug fix with scope
fix(restore): handle minimized windows correctly

# Feature with body
feat: use first-frame signal for faster restoration

Use the compositor's first-frame signal to resize windows before
they are painted, reducing visible flicker during restoration.

# Breaking change
feat!: drop support for GNOME 45

BREAKING CHANGE: minimum supported GNOME version is now 46
```

## Testing

**No automated tests exist.** This extension must be tested manually:

1. Install via `./install.sh`
2. Log out and log back in (required on Wayland)
3. Enable extension via GNOME Extensions app or `gnome-extensions enable window-size-tracker@gnome-extension`
4. View logs: `journalctl -f -o cat /usr/bin/gnome-shell`
5. Look for `[WindowSizeTracker]` prefixed log messages

### Manual Test Scenarios

- Open an app, resize it, close it, reopen it -> size should be restored
- Resize an app, wait 1 second (debounce), check logs for "STATE SAVED"
- Test with multiple apps to verify per-app tracking
- Test maximized/fullscreen windows are not restored to saved size

## Linting/Formatting

**No linting or formatting tools are configured.** Follow the code style guidelines below.

## Code Style Guidelines

### Language & Environment

- **JavaScript ES Modules** targeting GNOME Shell 49
- Uses `gi://` imports for GNOME libraries (GLib, Gio, Meta, Shell)
- Uses `resource:///` imports for GNOME Shell internal modules
- Code runs directly in GNOME Shell process - no transpilation

### File Structure

```
window-size-tracker@gnome-extension/
  extension.js    # All extension logic in single file
  metadata.json   # Extension metadata (uuid, name, shell-version)
```

### Import Order

1. GLib/GNOME libraries from `gi://` (GLib, Gio, Meta, Shell)
2. GNOME Shell modules from `resource:///`
3. Local imports (if any)

```javascript
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
```

### Naming Conventions

| Element               | Convention             | Example                        |
|-----------------------|------------------------|--------------------------------|
| Constants             | SCREAMING_SNAKE_CASE   | `SAVE_DEBOUNCE_MS`             |
| Classes               | PascalCase             | `WindowDataStore`              |
| Methods/Functions     | camelCase              | `_saveWindowSize`              |
| Private methods       | Underscore prefix      | `_onWindowCreated`             |
| Private fields        | Underscore prefix      | `this._dataStore`              |
| Signal handlers       | `_on` prefix           | `_onSizeChanged`               |
| Boolean methods       | `is` prefix            | `_isTrackableWindow`           |

### Formatting

- **Indentation**: 4 spaces (no tabs)
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Trailing commas**: Not used
- **Line length**: ~100 characters (soft limit)
- **Braces**: Same line for control structures

### Class Structure

1. Constructor
2. Public methods
3. Private methods (prefixed with `_`)
4. Signal handlers (`_on*` methods)
5. Cleanup methods (`destroy`, `disable`)

### Error Handling

- Wrap risky operations (file I/O, window access) in try-catch
- Log errors with `console.error()` using the extension prefix
- Fail gracefully - don't crash GNOME Shell

### Logging

Always prefix log messages with `[WindowSizeTracker]`:

```javascript
console.log('[WindowSizeTracker] Extension enabled');
console.warn('[WindowSizeTracker] Invalid data format, resetting');
console.error(`[WindowSizeTracker] Error: ${e.message}`);
console.debug(`[WindowSizeTracker] Saved ${windowId}: ${width}x${height}`);
```

### Async Patterns

- Use async/await for asynchronous operations
- Use GLib.timeout_add for scheduling (not setTimeout)
- Wrap callback-based APIs in Promises when needed

### Resource Management

- Track all signal connections and timeout IDs
- Clean up resources in `disable()` or `destroy()` methods
- Use Maps to track per-window resources

### GNOME Shell API Notes

- Use `Meta.is_wayland_compositor()` to check for Wayland
- Use `window.is_maximized()` (GNOME 49 API, not `get_maximized()`)
- Use `Shell.WindowTracker.get_default()` for app identification
- Use `global.display` for display-level signals
- Use `global.compositor.get_window_actors()` for window enumeration

### Extension Lifecycle

```javascript
export default class MyExtension extends Extension {
    enable() {
        // Initialize resources, connect signals
    }

    disable() {
        // Disconnect ALL signals, clear ALL timeouts
        // Set all references to null
        // This is critical - leaked resources crash GNOME Shell
    }
}
```

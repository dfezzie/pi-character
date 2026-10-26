# pi-character

Animated ASCII companions for your Pi terminal. Pick a bundled character or generate your own.

![Pi character demo: Cray at startup, live character previews, and a saved character in pink.](https://github.com/dfezzie/pi-character/raw/refs/heads/main/docs/media/demo.gif)

Captured from a real Pi session: startup, live previews, saving a selection, and changing its color.
The terminal view is cropped to the character and controls. No model tokens were used.

Characters play locally, with no model calls or token usage at startup. Requires **Pi 1.4.0+**;
no custom Pi build or additional runtime dependencies are needed.

## Quick start

Install the published package from npm:

```sh
pi install npm:pi-character
```

Restart Pi or run `/reload`. **Cray the Crawfish** appears alongside Pi's original startup header.

Open the character menu:

```text
/character
```

Choose **Choose character**, then use **↑ / ↓** to preview the animations. Press **Enter** to save
your choice, or **Escape** to return to your previous character.

## Meet the characters

Five characters are included and ready to use:

- **Cray the Crawfish** — the default welcome character.
- **Dozy the Fox Wizard** — a sleepy fox in a wizard hat.
- **Arlo the Armadillo** — an armored companion with a tail wag.
- **Ori the Oriole** — a little bird perched on a twig.
- **Fern the Fox** — a woodland fox with a bushy tail.

Your selection and color preference are remembered across restarts.

## Everyday controls

| Command             | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `/character`        | Open the menu                                          |
| `/character select` | Browse bundled and saved characters with live previews |
| `/character color`  | Choose a color                                         |
| `/character show`   | Enable and display your selected character             |
| `/character off`    | Hide the character, including on future starts         |

In the character picker:

| Key        | What it does                                                         |
| ---------- | -------------------------------------------------------------------- |
| **↑ / ↓**  | Preview the highlighted character                                    |
| **Enter**  | Save your selection                                                  |
| **Escape** | Restore your previous character and visibility                       |
| **r**      | Generate a new version of the highlighted character; **uses tokens** |
| **d**      | Delete the highlighted character after confirmation                  |

Characters hide while you type or when the terminal is too small. Starting an agent task hides
the character for the rest of that session; use `/character show` to bring it back. It appears
again in a new session unless you turned it off.

### Colors

By default, the artwork and name follow Pi's theme accent. Use the color menu or set one directly:

```text
/character color default
/character color original
/character color pink
```

`original` uses the character's own palette color. Fixed colors are `cyan`, `orange`, `green`,
`pink`, `blue`, and `yellow`. Colors persist across character changes and restarts.
Setting `NO_COLOR` disables the character's ANSI palette.

## Generate your own

**Generation and rerolls use model tokens.** Playing saved or bundled characters is local.

Describe a character using Pi's current model and authentication:

```text
/character generate a tiny moon wearing headphones
```

Each result is animated for preview before you decide:

- **Keep character** saves it to your library and selects it.
- **Reroll (uses tokens)** generates another attempt.
- **Cancel** restores your previous character without saving the preview.

To stop an in-progress request:

```text
/character cancel
```

Cancellation is available during generation and preview. Once the final preferences
write begins after **Keep character**, saving finishes before character commands
are available again. If a command arrives during that brief step, Pi asks you to
retry after the save finishes.

You can also press **r** in the picker to reroll an existing character. This reuses its description
and original generation model when available. The saved version is replaced only after you keep
a valid result.

### Choose a generation model

List models registered in Pi, then select one for a single generation:

```text
/character models
/character generate --model provider/model-id a tiny moon wearing headphones
```

The override applies only to that request; it leaves your Pi session model and global settings
unchanged. A model's presence in the catalog does not guarantee that your provider account can
use it.

### What gets sent and saved

Generation sends a dedicated character prompt and your description through Pi's model registry.
It does not send your coding conversation or tools, and the result is not added to conversation
history. Requests time out after two minutes and are never retried automatically. Failed or
invalid results leave your existing character usable.

Only previews you keep enter your library. Generated artwork is validated JSON data and is never
executed as code.

## Import and storage

Import a character JSON file in the original Codex prototype format or as a bare sprite:

```text
/character import /path/to/character.json
```

Characters and preferences live in `~/.pi/agent/characters/`, or in `characters/` under
`PI_CODING_AGENT_DIR` when set. The directory contains JSON assets with generation metadata and
`settings.json` for your selection, color, and enabled state.

Deleting a character from the picker archives it in `characters/.trash/`. Deleted characters stay
out of the picker across restarts, including bundled presets.

## Uninstall

```sh
pi remove npm:pi-character
```

Your saved characters and preferences remain. To reset them as well, separately delete the
characters directory described above.

## Development

Use Node **22.19+**. Install development dependencies, then run the checks and offline tests:

```sh
npm ci --legacy-peer-deps
npm run build
```

To load the checkout for a single Pi session:

```sh
pi -e /path/to/pi-character
```

To install a local checkout instead, use its absolute path:

```sh
pi install /path/to/pi-character
```

Remove a local installation with `pi remove /path/to/pi-character`. Pass the package directory so
Pi reads its manifest and loads only `src/index.ts`. Use one loading method at a time: npm, local
installation, or `-e`.

### Project layout

```text
src/
  index.ts        Pi lifecycle, widget, menus, and commands
  character.ts    Character validation, storage, and frame layout
  generation.ts   Model requests, cancellation, and errors
assets/           Bundled character JSON presets
test/             Unit tests, fixtures, and terminal smoke harness
```

Application code lives in `src/`, tests in `test/`, and presets in `assets/`. Tooling configuration
stays at the package root. Pi loads TypeScript source directly, so no compilation or `dist/`
directory is needed. Pi supplies its API and terminal UI packages at runtime.

### Code reviews

In a repository checkout, ask **review the current changes** (or name a commit range or
component). [The review workflow](docs/code-review.md) runs three independent Orca reviewers
for correctness, maintainability, and verification, followed by a separate pragmatic decider.
Reviews are read-only by default. The decider accepts or rejects suggestions based on evidence,
readability, maintenance cost, and this package's small scope.

### Checks

| Command                                   | What it checks                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `npm run build`                           | Lint, formatting, types, and offline tests                                |
| `npm run check`                           | Lint, formatting, and types                                               |
| `npm test`                                | Offline asset, generation, storage, lifecycle, and terminal-harness tests |
| `npm run test:smoke`                      | This checkout in a real Pi PTY with isolated temporary configuration      |
| `npm run lint` / `npm run lint:fix`       | ESLint checks / fixes                                                     |
| `npm run format` / `npm run format:check` | Prettier formatting / checks                                              |
| `npm run typecheck`                       | TypeScript checks for source, tests, and tooling                          |

Run `node test/smoke.ts` to check the local package already installed in Pi. Add
`--generate --model provider/model-id` to spend tokens on one generation; this copies provider
credentials into temporary state, which is removed after the run. Add `--output /path/to/evidence`
to save terminal snapshots and generated assets.

The terminal harness uses `node-pty` and `@xterm/headless` and has been verified on macOS. Platforms
without a compatible prebuilt PTY binary require native build tools to install `node-pty`.

### Presets and packaging

To ship a preset, add its reviewed JSON to `assets/` and the startup preset list in `src/index.ts`.
Personal generations live outside the repository. Local `generated/` exports and `validation/`
test artifacts are gitignored.

Assets are limited to 64 KiB, printable ASCII, 4–12 frames, 4–14 rows, 36 columns, a fixed palette,
and 80–600 ms frame durations. Animation timers are released on widget replacement, task start,
reload, and exit.

Run `npm pack --dry-run` or `npm pack` to review release contents. Packing runs `npm run build`;
the package includes source, presets, demo media, README, and license. Asset paths resolve relative to the
extension module, so playback works from any working directory.

### Release

```sh
npm run release
```

Checks the package, bumps the patch version, and asks before publishing to npm.
Run `npm run release -- --help` for options.

Licensed under [MIT](LICENSE).

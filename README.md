# Tabby Sticky Commands

![Status](https://img.shields.io/badge/status-experimental%20alpha-orange?style=flat-square)
![Tabby](https://img.shields.io/badge/Tabby-plugin-6f42c1?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-4.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Webpack](https://img.shields.io/badge/Webpack-5-8DD6F9?style=flat-square&logo=webpack&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-tested-0078D4?style=flat-square&logo=windows11&logoColor=white)
![SSH](https://img.shields.io/badge/SSH-tested-4b5563?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![npm](https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square&logo=npm)
![Built with ChatGPT](https://img.shields.io/badge/built%20with-ChatGPT-10a37f?style=flat-square)
![Coded with Codex](https://img.shields.io/badge/coded%20with-Codex-111827?style=flat-square)

Experimental Tabby terminal plugin for keeping command context visible while scrolling through terminal output.

Tabby Sticky Commands adds a small sticky command bar above the terminal viewport so the command that produced the current output stays visible during long scrollback sessions. It is intended for everyday terminal work where output can get lengthy, including SSH sessions, deployments, logs, migrations, package installs, and local development commands.

Copy output is included as a secondary experimental action. When retained output is available for the current command block, the sticky bar can copy that command and its captured output without manually selecting a terminal region.

## What it does

| Area | Current state |
| --- | --- |
| Purpose | Keeps command context visible above the terminal viewport while reading long output. |
| Status | Experimental alpha, in active local use. |
| Tested shells | CMD, PowerShell, SSH. |
| Tested input | Typed commands and pasted commands. |
| Copy output | Secondary experimental action when retained output has been captured. |
| Install path | Manual local Tabby plugin install. |
| Publishing | Not published to npm. |

## Status

Experimental alpha.

The plugin works well enough for active local use in the tested Windows Tabby setup. It is not published, versioned as a stable release, or guaranteed across every shell, terminal frontend, reconnect path, or multiplexer setup.

The core direction is sticky command context while scrolling. Copy output is useful today, but it remains a secondary experimental feature while command-to-output mapping and scroll-aware behavior continue to evolve.

## Tested target

- Tabby 1.0.233
- Windows 11
- Local CMD
- Local PowerShell
- SSH sessions
- Long-output scrolling
- Typed command input
- Pasted command input
- Fast tab switching

## Current behaviour

The current implementation has been manually checked for:

- CMD typed command capture
- CMD pasted command capture
- PowerShell typed command capture
- PowerShell pasted command capture
- SSH typed command capture
- SSH pasted command capture
- sticky command bar visibility while scrolled through long output
- tab switching across CMD, PowerShell, and SSH
- one sticky command bar per terminal tab in DOM checks
- no duplicate sticky command bars observed
- no visible raw terminal control codes in captured command text
- no previous debug logging strings left in the installed build
- CMD copy-output action copied a 200-line output block from the sticky command bar
- copied CMD output included the command context and expected output from line 1 through line 200

## Goal

Keep the relevant command visible while reading terminal output, especially when the prompt and command have scrolled off screen.

The longer-term direction is for the sticky command context to follow the output currently being viewed, not only the newest command. Copy output can support that workflow, but it should not define the product by itself.

## How it works

The plugin adds a terminal decorator that overlays a compact sticky command bar above the terminal viewport.

Command input is captured through the Tabby terminal session middleware path when available. This is needed because pasted command text is not always visible through the older terminal input observable path.

Output capture for the experimental copy-output action also uses the Tabby session middleware path. The plugin keeps a bounded in-memory set of recent command blocks per terminal tab and caps retained output so a runaway command does not grow memory without bound.

The sticky command bar shows a `Copy output` action when the latest command block has retained output. Copied text starts with the command line, followed by the retained output block.

The plugin falls back to the older input observable path only when the middleware stack is unavailable. That fallback supports command capture only, not copy-output capture.

## Privacy and retention

- Raw terminal input and output should not be logged.
- Terminal transcripts are not persistently stored by the plugin.
- Retained output is bounded and kept in memory only.
- Copying output requires a manual user action.

## Manual Windows install or update

Build the plugin:

    cd /d C:\Projects\tabby-sticky-commands
    npm.cmd run build

Copy the built plugin into the active Tabby plugin folder:

    mkdir "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-commands" 2>nul
    copy package.json "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-commands\package.json" /Y
    xcopy dist "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-commands\dist\" /E /I /Y

Restart Tabby after copying the build.

## Development notes

A separate Tabby dev profile was attempted using `--user-data-dir` and a copied portable-style Tabby folder. On the tested Windows setup, parallel isolated Tabby launch was not reliable while daily Tabby was already running.

For now, routine plugin verification uses short planned Tabby restart windows. Use a VM or Windows Sandbox for riskier isolated testing.

## Known limits

- Not a stable release.
- Not published to npm.
- Not verified across every Tabby frontend.
- Not verified across tmux or screen.
- Not verified across all reconnect and restore paths.
- Command parsing is deliberately simple.
- Multiline commands may not be represented perfectly.
- Sticky context currently favors the latest command block while scroll-position-aware behavior is still being developed.
- Copy output is secondary and experimental.
- Copy output currently uses retained command output, not a fully resolved scroll-position-aware command block.
- Copy output does not have a shell-level completion signal, so trailing prompt text may be included.
- Output capture is available through the middleware path only, not through the legacy input observable fallback.
- Shell prompts and terminal control sequences can vary by shell, theme, and remote host.
- The plugin should not log raw terminal input or output.

## Non-goals for the current alpha

- Perfect shell parsing
- Perfect tmux or screen support
- Full VS Code sticky-scroll parity
- npm publishing before an explicit release decision
- A guarantee that every terminal workflow is covered

## Development credit

This project was built by Mike Pearce with hands-on assistance from ChatGPT and Codex.

## Related Tabby feature request

https://github.com/Eugeny/tabby/issues/11256

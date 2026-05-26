# Tabby Sticky Command Header

![Status](https://img.shields.io/badge/status-experimental%20alpha-orange?style=flat-square)
![Tabby](https://img.shields.io/badge/Tabby-plugin-6f42c1?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-4.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Webpack](https://img.shields.io/badge/Webpack-5-8DD6F9?style=flat-square&logo=webpack&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-tested-0078D4?style=flat-square&logo=windows11&logoColor=white)
![SSH](https://img.shields.io/badge/SSH-tested-4b5563?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![npm](https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square&logo=npm)

Experimental Tabby terminal plugin for a VS Code-style sticky command header with a v0 copy-output action.

Keep the command that produced the current output visible while scrolling through long terminal output, then copy the retained output for that command from the sticky header. This is especially useful during SSH work, deployments, logs, migrations, package installs, and AI coding assistant output.

## What it does

| Area | Current state |
| --- | --- |
| Purpose | Shows the latest command in a sticky header above the terminal viewport and can copy retained output for that command. |
| Status | Experimental alpha, now in active local use. |
| Tested shells | CMD, PowerShell, SSH. |
| Tested input | Typed commands and pasted commands. |
| Copy output | v0 available from the sticky header when output has been captured. |
| Install path | Manual local Tabby plugin install. |
| Publishing | Not published to npm. |

## Status

Experimental alpha.

The plugin now works well enough for active local use in the tested Windows Tabby setup. It is still not published, versioned as a stable release, or guaranteed across every shell, terminal frontend, reconnect path, or multiplexer setup.

The sticky command header proof works for local CMD, local PowerShell, and SSH sessions. The v0 copy-output action has been added so long command output can be copied without manually selecting the whole terminal region.

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

## Verified behaviour

The current implementation has been manually verified for:

- CMD typed command capture
- CMD pasted command capture
- PowerShell typed command capture
- PowerShell pasted command capture
- SSH typed command capture
- SSH pasted command capture
- sticky header visibility while scrolled through long output
- tab switching across CMD, PowerShell, and SSH
- one sticky header per terminal tab in DOM checks
- no duplicate sticky headers observed
- no visible raw terminal control codes in captured command text
- no previous debug logging strings left in the installed build
- CMD copy-output action copied a 200-line output block from the sticky header
- copied CMD output included the command context and expected output from line 1 through line 200

## Goal

Show a sticky command header at the top of the terminal viewport so users can see which command produced the output they are reading, and copy the retained output for the current command when needed.

## Operator workflow expectation

The practical operator workflow is that ChatGPT writes proof commands so the final runnable command emits all required evidence in one labelled output block.

Mike should be able to scroll to that command in Tabby, click **Copy output**, and paste the copied output back to ChatGPT for review.

Good command prompts should therefore use one wrapper command by default, such as a Bash heredoc wrapper or a PowerShell script block, with labelled sections and bounded output. They should not ask Mike to run several independent commands and manually assemble separate outputs unless a wrapper is not practical.

## Operator-grade target

The intended end state is copyable command evidence that is exact enough for Mike as the operator and ChatGPT as the reviewer.

Operator-grade behaviour means:

- the sticky header follows the command whose output is currently being viewed, not only the newest command;
- `Copy output` copies the visible command block, including the correct command label and only that block's retained output;
- heredoc and multiline wrappers keep the opening command label, such as `bash <<'SH'`, and do not label the block as the delimiter;
- copied output preserves useful evidence such as warnings, URLs, JSON, logs, prompts, errors, command results, and section headings;
- copied output removes obvious terminal animation noise and carriage-return/progress rewrites where safe;
- copied text clearly says when output has been truncated;
- copied text is useful without separate terminal scrollback because the command printed the needed context;
- latest-command copying remains as a safe fallback when scroll mapping is unavailable;
- raw terminal input and output are not logged or persisted;
- memory stays bounded;
- manual checks cover CMD, PowerShell, SSH, typed commands, pasted commands, long output, multiple command blocks, tab switching, and plugin restart.

## How it works

The plugin adds a terminal decorator that overlays a small sticky header above the terminal viewport.

Command input is captured through the Tabby terminal session middleware path when available. This is needed because pasted command text is not always visible through the older terminal input observable path.

Output capture for the v0 copy-output action also uses the Tabby session middleware path. The plugin keeps a small in-memory set of recent command blocks per terminal tab and caps retained output so a runaway command does not grow memory without bound.

The sticky header shows a `Copy output` action when the latest command block has retained output. Copied text starts with the command line, followed by the retained output block.

The plugin falls back to the older input observable path only when the middleware stack is unavailable. That fallback supports command capture only, not copy-output capture.

## Manual Windows install or update

Build the plugin:

    cd /d C:\Projects\tabby-sticky-command-header
    npm.cmd run build

Copy the built plugin into the active Tabby plugin folder:

    mkdir "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-command-header" 2>nul
    copy package.json "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-command-header\package.json" /Y
    xcopy dist "%APPDATA%\tabby\plugins\node_modules\tabby-sticky-command-header\dist\" /E /I /Y

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
- Copy output is based on the latest command block, not an older scroll-position-aware command block.
- v0 does not have a shell-level completion signal, so trailing prompt text may be included in copied output.
- Output capture is available through the middleware path only, not through the legacy input observable fallback.
- Shell prompts and terminal control sequences can vary by shell, theme, and remote host.
- The plugin should not log raw terminal input or output.

## Non-goals for v0

- Perfect shell parsing
- Perfect tmux or screen support
- Full VS Code sticky-scroll parity
- Scroll-position-aware history for older command blocks
- npm publishing before an explicit release decision
- A guarantee that every terminal workflow is covered

## Related Tabby feature request

https://github.com/Eugeny/tabby/issues/11256

# Tabby Sticky Command Header

Experimental Tabby terminal plugin for a VS Code-style sticky command header.

The goal is to keep the command that produced the current output visible while scrolling through long terminal output, especially during SSH work, deployments, logs, migrations, package installs, and AI coding assistant output.

## Status

Experimental alpha.

The basic proof now works for local CMD, local PowerShell, and SSH sessions in the tested Windows Tabby setup. It is usable for manual testing, but it is not yet published, versioned as a stable release, or guaranteed across every shell, terminal frontend, reconnect path, or multiplexer setup.

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

## Goal

Show a sticky command header at the top of the terminal viewport so users can see which command produced the output they are reading.

## How it works

The plugin adds a terminal decorator that overlays a small sticky header above the terminal viewport.

Command input is captured through the Tabby terminal session middleware path when available. This is needed because pasted command text is not always visible through the older terminal input observable path.

The plugin falls back to the older input observable path only when the middleware stack is unavailable.

## Manual Windows install or update

Build the plugin:

    cd /d C:\HV-Repos\tabby-sticky-command-header
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
- Shell prompts and terminal control sequences can vary by shell, theme, and remote host.
- The plugin should not log raw terminal input.

## Non-goals for v0

- Perfect shell parsing
- Perfect tmux or screen support
- Full VS Code sticky-scroll parity
- npm publishing before an explicit release decision
- A guarantee that every terminal workflow is covered

## Related Tabby feature request

https://github.com/Eugeny/tabby/issues/11256

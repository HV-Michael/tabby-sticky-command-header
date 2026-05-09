# Tabby Sticky Command Header

Experimental Tabby terminal plugin for a VS Code-style sticky command header.

The goal is to keep the current command visible while scrolling through long terminal output, especially during SSH work, deployments, logs, migrations, package installs, and AI coding assistant output.

## Status

Early technical spike. Not ready for daily use.

## Initial target

- Tabby 1.0.232
- Windows 11
- xterm / xterm-webgl
- Local shell
- SSH sessions
- Scroll on input: On

## Goal

Show a sticky command/prompt header at the top of the terminal viewport so users can see which command produced the output they are reading.

## Non-goals for v0

- Perfect shell parsing
- Perfect tmux/screen support
- Full VS Code parity
- npm publishing before the proof of concept works

## Related Tabby feature request

https://github.com/Eugeny/tabby/issues/11256

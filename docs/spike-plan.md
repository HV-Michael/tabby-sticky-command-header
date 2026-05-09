# Technical Spike Plan

## Question

Can a Tabby plugin provide a useful sticky command header without requiring changes to Tabby core?

## First proof

- Attach to terminal tabs using Tabby terminal extension points.
- Capture submitted command text.
- Render a sticky overlay at the top of the terminal.
- Hide the overlay when the terminal is at the bottom.
- Avoid interfering with Tabby's existing scroll behaviour.

## Test matrix

- Windows 11
- Tabby 1.0.232
- Scroll on input: On
- Local shell
- SSH session
- Long command output
- Long log output

## Decision point

If the plugin API cannot access enough terminal scroll state, move the proposal towards a Tabby core PR instead of forcing a brittle plugin.

# Gas Pipes 1.4.0

Extends Sandustry's existing **Pump -> Pipe(s) -> Liquid Vent** water network so
it can also move elements whose live definition has `matterType === Gas`.

## What changed in 1.4.0

1.3.0 looked for a `waterBuffer++` operation that does not exist in the current
vanilla Pump implementation. The current game increments a local moved-count and
uses `waterBuffer` only for output shortfall. As a result, 1.3.0 could resolve
zero Pump candidates and contribute zero patches.

1.4.0 resolves the real recurring Pump path and modifies it atomically in its
own lexical scope:

- Water still uses the same vanilla Pump / Pipe / Liquid Vent network.
- Gas is accepted by the same intake scan.
- The exact input element type is kept in a FIFO buffer.
- The source cell is cleared with the actual old element type.
- The Liquid Vent creates the same type using Sandustry's own element factory.
- Buffered output preserves types across ticks.

On the currently inspected 0.5.4 bundle, Steam and Fire are Gas. The mod checks
the game's live matter-definition table rather than relying only on those names.

## Install

Install the ZIP through **SandLoader Mods -> Install from ZIP**, replace the old
Gas Pipes version, then completely restart Sandustry.

Use the exact same setup that already transports Water:

`Gas -> Pump -> Pipe(s) -> Liquid Vent`

For diagnostics, run `gaspipes` in the SandLoader console after the Pump has
been active for a moment.

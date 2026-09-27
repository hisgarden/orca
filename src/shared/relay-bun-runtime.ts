/** Oldest Bun with `Bun.Terminal`, which the relay needs in place of node-pty. */
export const MIN_RELAY_BUN_VERSION = '1.3.5'

// Why --no-install: with no node_modules in reach Bun fetches missing imports from the registry at runtime.
export const BUN_RELAY_RUNTIME_FLAGS = ['--no-install'] as const

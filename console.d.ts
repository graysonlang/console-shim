export type ConsoleSinkLevel = "debug" | "error" | "info" | "log" | "warn";

export type ConsoleSink = (level: ConsoleSinkLevel, message: string) => void;

/**
 * Register a sink to receive (level, message) pairs for every console call.
 * Messages logged before the first sink was registered are buffered and
 * flushed to that sink. Returns an unsubscribe function.
 */
export function addConsoleSink(sink: ConsoleSink): () => void;

export function removeConsoleSink(sink: ConsoleSink): void;

export default addConsoleSink;

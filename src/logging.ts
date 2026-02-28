/**
 * Structured logging module for Infoflow extension.
 * Provides consistent logging interface across all Infoflow modules.
 */

import type { RuntimeLogger } from "openclaw/plugin-sdk";
import { getInfoflowRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Logger Factory
// ---------------------------------------------------------------------------

/**
 * Creates a child logger with infoflow-specific bindings.
 * Uses the PluginRuntime logging system for structured output.
 */
function createInfoflowLogger(module?: string): RuntimeLogger {
  const runtime = getInfoflowRuntime();
  const bindings: Record<string, unknown> = { subsystem: "gateway/channels/infoflow" };
  if (module) {
    bindings.module = module;
  }
  return runtime.logging.getChildLogger(bindings);
}

// ---------------------------------------------------------------------------
// Module-specific Loggers (lazy initialization)
// ---------------------------------------------------------------------------

let _sendLog: RuntimeLogger | null = null;
let _webhookLog: RuntimeLogger | null = null;
let _botLog: RuntimeLogger | null = null;
let _parseLog: RuntimeLogger | null = null;

/**
 * Logger for send operations (private/group message sending).
 */
export function getInfoflowSendLog(): RuntimeLogger {
  if (!_sendLog) {
    _sendLog = createInfoflowLogger("send");
  }
  return _sendLog;
}

/**
 * Logger for webhook/monitor operations.
 */
export function getInfoflowWebhookLog(): RuntimeLogger {
  if (!_webhookLog) {
    _webhookLog = createInfoflowLogger("webhook");
  }
  return _webhookLog;
}

/**
 * Logger for bot/message processing operations.
 */
export function getInfoflowBotLog(): RuntimeLogger {
  if (!_botLog) {
    _botLog = createInfoflowLogger("bot");
  }
  return _botLog;
}

/**
 * Logger for request parsing operations.
 */
export function getInfoflowParseLog(): RuntimeLogger {
  if (!_parseLog) {
    _parseLog = createInfoflowLogger("parse");
  }
  return _parseLog;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

export type FormatErrorOptions = {
  /** Include stack trace in the output (default: false) */
  includeStack?: boolean;
};

/**
 * Format error message for logging.
 * @param err - The error to format
 * @param options - Formatting options
 */
export function formatInfoflowError(err: unknown, options?: FormatErrorOptions): string {
  if (err instanceof Error) {
    if (options?.includeStack && err.stack) {
      return err.stack;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Log a message when verbose mode is enabled.
 * Checks shouldLogVerbose() via PluginRuntime, then writes to console for
 * --verbose terminal output. Safe to call before runtime is initialized.
 */
export function logVerbose(message: string): void {
  try {
    if (!getInfoflowRuntime().logging.shouldLogVerbose()) return;
    console.log(message);
  } catch {
    // runtime not available, skip verbose logging
  }
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Reset all cached loggers. Only use in tests. */
export function _resetLoggers(): void {
  _sendLog = null;
  _webhookLog = null;
  _botLog = null;
  _parseLog = null;
}

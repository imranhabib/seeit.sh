// Assigns each call to a turn: one prompt the user typed, plus every model
// call and tool loop until the final answer.
//
// Codex sends its turn ID. Claude Code does not, so the gateway keeps the
// current turn per session and starts a new one when a request carries new
// user text (see readRequest's startsNewTurn). Must be called in request
// order; app.ts schedules it with setImmediate, which keeps that order.

import { randomUUID } from "node:crypto";
import type { RequestInfo } from "@seeit/core";

export function createTurnTracker() {
  // session ID -> current turn ID. One small entry per session; sessions are
  // few for a single user, so the map is never pruned.
  const current = new Map<string, string>();

  return {
    turnFor(info: RequestInfo): string | null {
      if (info.kind === "background") return null;
      if (info.explicitTurnId) return info.explicitTurnId;
      if (!info.sessionId) return null;
      if (info.startsNewTurn || !current.has(info.sessionId)) current.set(info.sessionId, randomUUID());
      return current.get(info.sessionId)!;
    },
  };
}

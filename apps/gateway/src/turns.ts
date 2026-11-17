// Assigns each call to a turn: one prompt the user typed, plus every model
// call and tool loop until the final answer.
//
// Codex sends its turn ID. Claude Code does not, so the gateway keeps the
// current turn per session and starts a new one when a request carries new
// user text (see readRequest's startsNewTurn). Must be called in request
// order; app.ts schedules it with setImmediate, which keeps that order.
//
// Rules for Claude Code, each seen live (PLAN.md, Iris findings):
// - Subagent calls (RequestInfo.agentId) belong to the turn that started the
//   subagent. Their first request ends in new user text (the task), but they
//   never start a turn, or the main loop's next call would land in it.
// - Background calls with a session ID are linked to the session's turn in
//   progress. A tool's own model calls (WebSearch's page reader) carry
//   nothing but the session ID, so this is the only way to count their
//   tokens in the turn that caused them. The link is inferred: a background
//   row with a turn_id was linked this way. Before the first turn (the
//   startup quota probe) there is nothing to link to.
// - After a failed call the harness sends the turn's first message again:
//   unchanged (a retry), or with a "resume" block added when the stream was
//   cut mid-answer. resendsTurnStart recognizes both, so they stay in the turn.

import { randomUUID } from "node:crypto";
import { resendsTurnStart, type RequestInfo } from "@seeit/core";

type Current = { turnId: string; startedBy: string | null };

export function createTurnTracker() {
  // session ID -> current turn. One small entry per session; sessions are
  // few for a single user, so the map is never pruned.
  const current = new Map<string, Current>();

  return {
    turnFor(info: RequestInfo): string | null {
      if (info.kind === "connectivity" || !info.sessionId) return info.kind === "turn" ? info.explicitTurnId : null;
      const now = current.get(info.sessionId);
      if (info.kind === "background") return now?.turnId ?? null;

      // Codex names its turns; remember the latest so background calls can link to it.
      if (info.explicitTurnId) {
        current.set(info.sessionId, { turnId: info.explicitTurnId, startedBy: null });
        return info.explicitTurnId;
      }
      const startsTurn = !info.agentId && info.startsNewTurn && !resendsTurnStart(now?.startedBy ?? null, info.turnKey);
      if (now && !startsTurn) return now.turnId;

      const next = { turnId: randomUUID(), startedBy: info.agentId ? null : info.turnKey };
      current.set(info.sessionId, next);
      return next.turnId;
    },
  };
}

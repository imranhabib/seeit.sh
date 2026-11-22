// Request bodies as pieces (ADR 0009, body_pieces / call_pieces).
//
// Every request repeats the session's history, so the ledger stores each
// distinct piece once per session and keeps each request as its list of
// pieces. Claude Code: `tools`, each `system` block, each message, and the
// other fields. Codex: each `input` item and the other fields.
//
// Claude Code moves `cache_control` to the newest message on every call. The
// markers are taken out before hashing and kept with the recipe, so an old
// message keeps its hash. A rebuilt request has the same content, but not
// always the same bytes (key order and spacing can differ).

import { createHash } from "node:crypto";
import { isObject, parseJson, type Harness, type Json } from "./provider/model.ts";
import type { RequestPiece } from "./records.ts";

/** The pieces of a request body, in order. A body that is not a JSON object is one "raw" piece. */
export function requestPieces(harness: Harness, text: string | null): RequestPiece[] {
  if (text === null) return [];
  const body = parseJson(text);
  if (!body) return [{ path: "raw", value: text, cacheControl: null }];

  const pieces: RequestPiece[] = [];
  const fields: Json = {};
  // The arrays that are cut item by item; other keys go into "fields" whole.
  const listed = harness === "claude" ? ["system", "messages"] : ["input"];
  for (const [key, value] of Object.entries(body)) {
    if (listed.includes(key) && Array.isArray(value)) {
      value.forEach((item, i) => pieces.push(piece(`${key}[${i}]`, item)));
    } else if (harness === "claude" && key === "tools") {
      pieces.push(piece("tools", value));
    } else {
      fields[key] = value;
    }
  }
  if (Object.keys(fields).length) pieces.push(piece("fields", fields));
  return pieces;
}

/** The request again, from its pieces in order. */
export function rebuildRequest(pieces: RequestPiece[]): unknown {
  if (pieces.length === 1 && pieces[0]!.path === "raw") return pieces[0]!.value;
  const body: Json = {};
  for (const p of pieces) {
    const value = restoreMarkers(p.value, p.cacheControl);
    const item = p.path.match(/^(\w+)\[(\d+)\]$/);
    if (p.path === "fields") Object.assign(body, value);
    else if (item) (body[item[1]!] ??= [])[Number(item[2])] = value;
    else body[p.path] = value;
  }
  return body;
}

/** sha256 of the piece's JSON. */
export function hashPiece(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Markers sit on the piece itself (a system block) or on its content blocks
// (a message). Only those two places are checked.
function piece(path: string, value: unknown): RequestPiece {
  if (!isObject(value)) return { path, value, cacheControl: null };
  const markers: Record<string, unknown> = {};
  const { cache_control, ...rest } = value;
  if (cache_control !== undefined) markers[""] = cache_control;
  if (Array.isArray(rest.content)) {
    rest.content = rest.content.map((block: unknown, i: number) => {
      if (!isObject(block) || block.cache_control === undefined) return block;
      const { cache_control: marker, ...plain } = block;
      markers[`content[${i}]`] = marker;
      return plain;
    });
  }
  return Object.keys(markers).length ? { path, value: rest, cacheControl: markers } : { path, value, cacheControl: null };
}

function restoreMarkers(value: unknown, markers: Record<string, unknown> | null): unknown {
  if (!markers || !isObject(value)) return value;
  const out: Json = { ...value };
  for (const [where, marker] of Object.entries(markers)) {
    const block = where.match(/^content\[(\d+)\]$/);
    if (where === "") out.cache_control = marker;
    else if (block && Array.isArray(out.content)) {
      out.content = [...out.content];
      out.content[Number(block[1])] = { ...out.content[Number(block[1])], cache_control: marker };
    }
  }
  return out;
}

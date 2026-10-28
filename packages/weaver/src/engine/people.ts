/**
 * People across platforms: signals cluster in people, so a good page points at its author's
 * other posts and profiles. The agent writes a `person` (profiles, names); a document is theirs
 * when a follow from one of their profiles found it, when its URL sits under a profile, or when
 * its channel is one of their names. The brief counts kept findings per person and lists the
 * kept pages whose author no follow and no person covers yet.
 */
import { hostOf } from "@wrenautomation/falcon/document";
import type { DocumentRecord, PersonRecord } from "../ledger/records.js";
import { kept, type RunState } from "./state.js";

/** A URL as a prefix key: host without www, path without its trailing slash, lower case. */
export function profileKey(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The latest record per name (case folded). */
export function peopleOf(state: RunState): PersonRecord[] {
  const out = new Map<string, PersonRecord>();
  for (const p of state.people) out.set(p.name.toLowerCase(), p);
  return [...out.values()];
}

/** A document's channel, else its hit's: a web opener knows none. */
function channelsOf(state: RunState): Map<string, string> {
  const hits = new Map(state.hits.map((h) => [h.id, h.channel]));
  const out = new Map<string, string>();
  for (const d of state.documents) {
    const c = d.channel ?? hits.get(d.hit);
    if (c) out.set(d.id, c);
  }
  return out;
}

/** Each document's person, by follow, URL prefix, then channel name. */
export function ownersOf(state: RunState): Map<string, PersonRecord> {
  const people = peopleOf(state);
  const keys = people.flatMap((p) =>
    p.profiles.flatMap((u) => {
      const k = profileKey(u);
      return k ? [{ k, p }] : [];
    }),
  );
  const channels = channelsOf(state);
  const names = new Map(people.flatMap((p) => [p.name, ...p.aka].map((n) => [n.toLowerCase(), p])));
  // A follow from a profile: its hits are the profile's posts.
  const byQuery = new Map<string, PersonRecord>();
  for (const q of state.queries) {
    if (q.follow?.as !== "posts") continue;
    const k = profileKey(q.follow.url);
    const fromDoc = q.follow.document
      ? state.documents.find((d) => d.id === q.follow?.document)
      : undefined;
    const p =
      keys.find((x) => k && (k === x.k || k.startsWith(`${x.k}/`)))?.p ??
      (fromDoc ? names.get(channels.get(fromDoc.id)?.toLowerCase() ?? "") : undefined);
    if (p) byQuery.set(q.id, p);
  }
  const queriesOfHit = new Map(state.hits.map((h) => [h.id, [...h.queries]]));
  for (const f of state.founds) queriesOfHit.get(f.hit)?.push(f.query);
  const out = new Map<string, PersonRecord>();
  for (const d of state.documents) {
    const k = profileKey(d.url);
    const p =
      (queriesOfHit.get(d.hit) ?? []).map((q) => byQuery.get(q)).find(Boolean) ??
      keys.find((x) => k && (k === x.k || k.startsWith(`${x.k}/`)))?.p ??
      names.get(channels.get(d.id)?.toLowerCase() ?? "");
    if (p) out.set(d.id, p);
  }
  return out;
}

export interface PersonView {
  id: string;
  name: string;
  profiles: string[];
  aka: string[];
  why: string;
  documents: number;
  /** Kept findings on their documents. */
  kept: number;
  /** Distinct sites their documents sit on. */
  sites: number;
}

/** People, most kept findings first. */
export function peopleView(state: RunState): PersonView[] {
  const owners = ownersOf(state);
  return peopleOf(state)
    .map((p) => {
      const docs = state.documents.filter((d) => owners.get(d.id) === p);
      const ids = new Set(docs.map((d) => d.id));
      return {
        id: p.id,
        name: p.name,
        profiles: p.profiles,
        aka: p.aka,
        why: p.why,
        documents: docs.length,
        kept: state.findings.filter((f) => ids.has(f.document) && kept(state, f)).length,
        sites: new Set(docs.map((d) => hostOf(d.url))).size,
      };
    })
    .sort((a, b) => b.kept - a.kept || a.name.localeCompare(b.name));
}

export interface Unfollowed {
  document: string;
  url: string;
  title?: string;
  channel?: string;
  kept: number;
}

/**
 * Kept pages no follow started from and no person owns: whose author's other posts and pages
 * like it are still unseen. Most kept findings first.
 */
export function unfollowedOf(state: RunState): Unfollowed[] {
  const owners = ownersOf(state);
  const channels = channelsOf(state);
  const followed = new Set(
    state.queries.flatMap((q) =>
      q.follow ? [q.follow.document, profileKey(q.follow.url)].filter(Boolean) : [],
    ) as string[],
  );
  const keptOn = new Map<string, number>();
  for (const f of state.findings)
    if (kept(state, f)) keptOn.set(f.document, (keptOn.get(f.document) ?? 0) + 1);
  return state.documents
    .filter((d: DocumentRecord) => {
      const k = profileKey(d.url);
      return (
        keptOn.get(d.id) && !owners.has(d.id) && !followed.has(d.id) && !(k && followed.has(k))
      );
    })
    .map((d) => {
      const channel = channels.get(d.id);
      return {
        document: d.id,
        url: d.url,
        ...(d.title ? { title: d.title } : {}),
        ...(channel ? { channel } : {}),
        kept: keptOn.get(d.id) ?? 0,
      };
    })
    .sort((a, b) => b.kept - a.kept);
}

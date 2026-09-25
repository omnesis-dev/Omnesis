// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source knows about one of its accounts.
 *
 * An account is identified today by the second half of a source id — the part
 * after the colon in `gmail:someone@example.com`. That string is doing at
 * least three unrelated jobs at once: it names a directory on disk, it is a
 * stable key in configuration and in every saved reference, and it is the only
 * place a platform's own idea of who this is has ever been written down.
 *
 * The third job is the one that does not fit. Nothing declares what the string
 * means, so everything downstream guesses. A survey of the tree found the
 * guessing in two places that matter: the self-identity resolver decides an
 * account is the operator's own email by testing whether it contains an `@`,
 * and a provider that needed to distinguish two tokens for one person had
 * nowhere to put the distinction, so it smuggled a second separator inside the
 * account id and then taught four other places to strip it back out.
 *
 * A descriptor is the same identity, declared. The id does not move — it is
 * still the key, still the directory name, still what every saved watch and
 * config block refers to — and the rename hazard that moving it would create
 * is avoided entirely. What changes is that the things consumers were
 * inferring are now stated by the only party that knows them.
 *
 * Every field but the id is optional, because most platforms answer only some
 * of these questions and a descriptor that demanded more would be filled in
 * with guesses — which is the situation this replaces.
 */

/** How to read a subject's value. */
export type AccountSubjectKind =
  /** An address, and the operator's own if it matches their identity. */
  | "email"
  /** A dialable number in E.164. */
  | "phone"
  /** A platform-local username, unique within that platform. */
  | "handle"
  /** An identifier with no meaning outside the platform that issued it. */
  | "opaque";

/**
 * What the platform says this account is.
 *
 * Typed rather than a bare string, because the consumers that want it want to
 * know which kind it is: an email can be matched against the operator's own
 * identity, a handle cannot, and treating one as the other is exactly the
 * heuristic this exists to remove.
 */
export interface AccountSubject {
  kind: AccountSubjectKind;
  value: string;
}

/**
 * The tenant an account is scoped to.
 *
 * Two accounts can be the same person at two organizations, and on some
 * platforms nothing the credential can call will say which — the resource
 * owner is not reported by any API a token has access to. So a tenant is
 * declared at the moment the connection is made, which is the only moment the
 * operator knows it.
 */
export interface AccountTenant {
  id: string;
  label?: string;
}

export interface AccountDescriptor {
  /**
   * The id this account is addressed by, unchanged.
   *
   * Still the key, still the directory name, still what every saved reference
   * and configuration block names. A descriptor describes an account; it does
   * not rename one.
   */
  id: string;

  /**
   * What to call this account in front of a person.
   *
   * The gain is for accounts whose id is not readable: an opaque workspace
   * identifier, a numeric athlete id, an item reference.
   *
   * It is the middle of three rungs. A running instance's `label` wins,
   * because it is resolved while the source is connected and can change — a
   * nickname fetched mid-sync. This one is what the source knew when the
   * operator made the connection. The definition's `name` is the fallback, and
   * names the family rather than the account.
   */
  label?: string;

  /** Who the platform says this is. */
  subject?: AccountSubject;

  /** Which organization, workspace or team this account is scoped to. */
  tenant?: AccountTenant;

  /**
   * Other identifiers that resolve to the same person on this platform.
   *
   * A messaging account with several numbers, an address with aliases. Used to
   * attribute documents to one person rather than several; not used to address
   * the account, which is what `id` is for.
   */
  aliases?: readonly AccountSubject[];
}

/** Whether a value is a descriptor rather than a bare account id. */
export function isAccountDescriptor(value: unknown): value is AccountDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * Read a descriptor out of whatever a source returned.
 *
 * Discovery has always returned bare ids, and most sources have nothing more
 * to say — a local store has one account called `local` and no platform behind
 * it. Widening the return rather than replacing it means a source declares
 * more only when it knows more.
 */
export function toAccountDescriptor(value: string | AccountDescriptor): AccountDescriptor {
  return typeof value === "string" ? { id: value } : value;
}

/**
 * What to show a person for this account.
 *
 * The id is the fallback because it is what every client shows today, so a
 * source that declares nothing loses nothing.
 */
export function accountLabel(descriptor: AccountDescriptor): string {
  return descriptor.label ?? descriptor.subject?.value ?? descriptor.id;
}

/**
 * The operator's own email on this account, if the source says it has one.
 *
 * Replaces testing an account id for an `@`. That test has one near miss
 * already in the tree — a labelled account of the form `login@organization`
 * contains an `@` and is not an address — and it is caught only by a second,
 * shape-based check that a future account id could also pass.
 */
export function accountEmail(descriptor: AccountDescriptor): string | undefined {
  if (descriptor.subject?.kind === "email") return descriptor.subject.value;
  return descriptor.aliases?.find((a) => a.kind === "email")?.value;
}

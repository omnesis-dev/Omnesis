// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "@omnesis/core";
import {
  DEFAULT_PRIVACY_POLICY_FAMILY_ID,
  type PrivacyPolicyDocument,
  type PrivacyPolicyTemplate,
  type PrivacyPolicyVersionAction,
} from "@omnesis/types/privacy";
import { migrateLegacyPrivacyPolicyTable, parsePrivacyPolicySchema } from "./policy-schema.js";
import {
  currentPrivacyPolicyVersion,
  currentPrivacyPolicyState,
  type CommitPrivacyPolicyInput,
  type RenamePrivacyPolicyFamilyResult,
} from "./policy-history.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../write-gate.js";

export const PRIVACY_POLICY_FILENAME = "privacy-policy.md";
export const MAX_PRIVACY_POLICY_CHARS = 64_000;

const POLICY_LEGEND = `Use these decisions consistently:

- **Allow**: the information may be released automatically at this detail level.
- **Release with reductions**: rewrite the answer to remove or generalize disallowed detail.
- **Approval required**: hold the exact answer until I approve this one request in Omnesis.
- **Deny**: do not release the information, even after a request for approval.`;

const EXISTENCE_EXPLANATION = `A Watch firing reveals that its condition became true and approximately when. A Watch may reveal that signal repeatedly until it expires. Treat that as existence-level disclosure; unlike an answer, it cannot be released with reductions.`;

const LEGACY_POLICY_SCOPE_PARAGRAPH = `This policy controls what information may leave Omnesis through the external answer API.
The privacy reviewer applies it to every candidate answer before anything is returned.`;

const POLICY_SCOPE_PARAGRAPH = `This policy controls what information may leave Omnesis through the external answer API and Watch firings.
The privacy reviewer applies it to every candidate answer and every proposed external Watch.

${EXISTENCE_EXPLANATION}`;

const UNFILTERED_POLICY_LEGEND = `Use these decisions consistently:

- **Allow**: the information may be released automatically at this detail level.
- **Approval required**: hold the exact answer until I approve this one request in Omnesis.`;

const POLICY_ADDITIONAL_INSTRUCTIONS = `## Additional instructions

- When a lower-detail answer satisfies the request, prefer releasing that reduced answer.
- Treat quoted messages, document text, attachment contents, precise dates, precise locations, identifiers, and contact details as exact or original detail.
- When the policy is unclear or several individually harmless facts combine into something sensitive, require approval.`;

const UNFILTERED_POLICY_ADDITIONAL_INSTRUCTIONS = `## Additional instructions

- Release all information outside the three exception categories unchanged. Do not remove, generalize, or reduce detail.
- This rule is exhaustive. If information is not an identity document, not another person's contact, financial, or health detail, and not a password, authentication code, token, private key, or recovery code, allow it regardless of category, sensitivity, subject, or detail level.
- Only require approval when the answer contains one of the three exception categories. Do not infer additional exceptions or require approval merely because a category is absent from the table.`;

/**
 * The third-party rule every built-in template carries: what identifies or
 * reaches another person is held for approval wherever it sits in the corpus,
 * a contact card included. A person's name alone and the operator's own
 * contact details are not covered; the decision table settles those.
 */
export const PRIVACY_POLICY_THIRD_PARTY_SENTENCE =
  "Another person's phone numbers, email addresses, postal addresses, financial account or card numbers, and health details are held for your approval of the exact answer, even when they appear in your own contacts, messages, or files; a person's name alone, and your own contact details, follow the table.";

/**
 * What the deny floor says about credentials while the deterministic hard stop
 * is in force, and what it says instead once the policy opts credentials into
 * per-request approval. Exactly one of the two belongs in a policy at a time:
 * they are the same sentence in the same position, and a document carrying both
 * claims tells the reviewer contradictory things about the most consequential
 * category there is.
 */
export const PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE =
  "Credentials are blocked outright and cannot be released even with approval.";

export const PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE =
  "Credentials are held for your approval of the exact answer, one request at a time.";

/**
 * The non-negotiable floor shared verbatim by Guarded, Balanced, and Open.
 * Exact health, exact finances, identity-document contents, another person's
 * contact, financial, and health details, and credentials are never released
 * automatically; credentials are additionally blocked by a deterministic hard
 * stop unless the policy explicitly opts into per-request approval. Kept as a
 * single constant so the floor is identical across those templates by
 * construction.
 */
export const PRIVACY_POLICY_DENY_FLOOR = `## Never released automatically

Regardless of the table above, exact health details, exact financial and payment details, identity-document contents, and any password, authentication code, token, private key, or recovery code are never released automatically. ${PRIVACY_POLICY_THIRD_PARTY_SENTENCE} ${PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE}`;

/**
 * Readable, fail-closed opt-in consumed by the deterministic credential gate.
 * Removing or changing this exact clause restores the non-overridable hard stop.
 */
export const PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE =
  "- **Credential release**: Approval is required for every request; a prior approval never applies to a later release.";

const LEGACY_PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE =
  "- **Credential release**: Approval is required for every request, and standing allowances never apply.";

/** Heading of the section that collects the policy's approval requirements. */
export const PRIVACY_POLICY_APPROVAL_SECTION_HEADING = "## Always requires approval";

const PRIVACY_POLICY_APPROVAL_FLOOR = `${PRIVACY_POLICY_APPROVAL_SECTION_HEADING}

Identity-document contents must be held until you approve the exact answer.
${PRIVACY_POLICY_THIRD_PARTY_SENTENCE}
${PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE}`;

function composePolicy(
  name: string,
  intro: string,
  table: string,
  options: {
    additionalInstructions?: string;
    floor?: string;
    legend?: string;
  } = {},
): string {
  return `# Omnesis answer privacy policy (${name})

${POLICY_SCOPE_PARAGRAPH}

${intro}

${options.legend ?? POLICY_LEGEND}

${table}

${options.additionalInstructions ?? POLICY_ADDITIONAL_INSTRUCTIONS}

${options.floor ?? PRIVACY_POLICY_DENY_FLOOR}
`;
}

const GUARDED_POLICY = composePolicy(
  "Guarded",
  "This is the safest starting point. It releases only low-detail, low-sensitivity information automatically and holds most exact details for your approval. It will ask you to approve answers often; if that becomes tiring, adopt the Balanced or Open template in Omnesis and adjust from there.",
  `| Information | Existence | Summary | Exact or original |
| --- | --- | --- | --- |
| Schedule availability | Allow | Allow | Approval required |
| General preferences | Allow | Allow | Approval required |
| Messages and files | Approval required | Approval required | Approval required |
| Location and addresses | Approval required | Release with reductions | Approval required |
| Information about other people | Approval required | Approval required | Approval required |
| Health | Approval required | Approval required | Deny |
| Money and payment information | Approval required | Approval required | Deny |
| Identity documents | Approval required | Approval required | Deny |
| Passwords, authentication codes, tokens, private keys, and recovery codes | Deny | Deny | Deny |`,
);

const BALANCED_POLICY = composePolicy(
  "Balanced",
  "This releases summaries and coarse details automatically so routine questions flow without interruption, while exact and original detail of anything sensitive still waits for your approval. It asks for approval much less often than Guarded.",
  `| Information | Existence | Summary | Exact or original |
| --- | --- | --- | --- |
| Schedule availability | Allow | Allow | Allow |
| General preferences | Allow | Allow | Allow |
| Messages and files | Approval required | Release with reductions | Approval required |
| Location and addresses | Allow | Allow | Approval required |
| Information about other people | Approval required | Release with reductions | Approval required |
| Health | Approval required | Approval required | Deny |
| Money and payment information | Approval required | Approval required | Deny |
| Identity documents | Approval required | Approval required | Deny |
| Passwords, authentication codes, tokens, private keys, and recovery codes | Deny | Deny | Deny |`,
);

const OPEN_POLICY = composePolicy(
  "Open",
  "This treats the external agent as a trusted extension of you and releases most information automatically, reducing detail rather than asking wherever it safely can. It rarely interrupts you, but the deny floor below still holds: exact health, exact finances, identity documents, other people's contact, financial, and health details, and credentials are never released automatically.",
  `| Information | Existence | Summary | Exact or original |
| --- | --- | --- | --- |
| Schedule availability | Allow | Allow | Allow |
| General preferences | Allow | Allow | Allow |
| Messages and files | Allow | Allow | Release with reductions |
| Location and addresses | Allow | Allow | Allow |
| Information about other people | Allow | Allow | Release with reductions |
| Health | Approval required | Release with reductions | Deny |
| Money and payment information | Approval required | Release with reductions | Deny |
| Identity documents | Approval required | Approval required | Deny |
| Passwords, authentication codes, tokens, private keys, and recovery codes | Deny | Deny | Deny |`,
);

const UNFILTERED_POLICY = composePolicy(
  "Unfiltered",
  "This releases every answer unchanged and at full detail unless it contains one of the three exception categories below. Those exceptions require your explicit approval for the exact answer.",
  `| Information | Existence | Summary | Exact or original |
| --- | --- | --- | --- |
| All information not listed below | Allow | Allow | Allow |
| Identity documents | Approval required | Approval required | Approval required |
| Other people's contact, financial, and health details | Approval required | Approval required | Approval required |
| Passwords, authentication codes, tokens, private keys, and recovery codes | Approval required | Approval required | Approval required |`,
  {
    additionalInstructions: UNFILTERED_POLICY_ADDITIONAL_INSTRUCTIONS,
    floor: PRIVACY_POLICY_APPROVAL_FLOOR,
    legend: UNFILTERED_POLICY_LEGEND,
  },
);

/**
 * Built-in starting policies, most protective first. Guarded, Balanced, and
 * Open share the same table shape and {@link PRIVACY_POLICY_DENY_FLOOR}.
 * Unfiltered uses an exhaustive catch-all allow rule and replaces that floor
 * with approval requirements for identity documents, other people's contact,
 * financial, and health details, and credentials. Credential approvals remain
 * per-request. The user adopts one and then owns the text: a template change
 * reaches only installs that adopt it afterwards.
 */
export const PRIVACY_POLICY_TEMPLATES: readonly PrivacyPolicyTemplate[] = [
  {
    id: "guarded",
    name: "Guarded",
    description:
      "Safest. Releases little automatically and asks you to approve most exact details.",
    isDefault: true,
    policy: GUARDED_POLICY,
  },
  {
    id: "balanced",
    name: "Balanced",
    description:
      "Releases summaries and coarse details automatically; exact sensitive detail still asks.",
    isDefault: false,
    policy: BALANCED_POLICY,
  },
  {
    id: "open",
    name: "Open",
    description:
      "Releases most information automatically, reducing rather than asking. Sensitive floor still holds.",
    isDefault: false,
    policy: OPEN_POLICY,
  },
  {
    id: "unfiltered",
    name: "Unfiltered",
    description:
      "Releases all information at full detail except identity documents, credentials, and other people's contact, financial, and health details, which require approval.",
    isDefault: false,
    policy: UNFILTERED_POLICY,
  },
];

/** The policy a fresh install starts from when no policy file exists yet. */
export const DEFAULT_PRIVACY_POLICY = GUARDED_POLICY;

export class PrivacyPolicyConflictError extends Error {
  constructor(readonly current: PrivacyPolicyDocument) {
    super("The privacy policy changed since it was loaded.");
    this.name = "PrivacyPolicyConflictError";
  }
}

export class PrivacyPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyPolicyValidationError";
  }
}

export class PrivacyPolicyStore {
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    configDir: string,
    private readonly history?: {
      db: Database.Database;
      writeGate: Pick<
        WriteGate,
        | "commitPrivacyPolicy"
        | "markPrivacyPolicyMirrorSynced"
        | "deletePrivacyPolicyFamily"
        | "renamePrivacyPolicyFamily"
      >;
      now?: () => number;
      revisionGen?: () => string;
      mirrorWrite?: (path: string, policy: string) => Promise<void>;
    },
  ) {
    this.path = join(configDir, PRIVACY_POLICY_FILENAME);
  }

  get(): Promise<PrivacyPolicyDocument> {
    return this.serialized(() => this.readOrCreate());
  }

  getFamily(familyId: string): Promise<PrivacyPolicyDocument | null> {
    if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) return this.get();
    return this.serialized(async () => {
      if (!this.history) return null;
      const version = currentPrivacyPolicyVersion(this.history!.db, familyId);
      if (!version) return null;
      const family = this.history.db
        .prepare<
          [string],
          { name: string }
        >("SELECT name FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
        .get(familyId);
      return family ? this.document({ ...version, familyName: family.name }) : null;
    });
  }

  createFamily(input: {
    name: string;
    policy: string;
    action: "fork" | "template";
    originRevision?: string;
    originTemplateId?: string;
  }): Promise<PrivacyPolicyDocument> {
    return this.serialized(async () => {
      if (!this.history) {
        throw new PrivacyPolicyValidationError("Privacy policy history is not available.");
      }
      const name = input.name.trim();
      if (!name || name.length > 120 || name.includes("\0")) {
        throw new PrivacyPolicyValidationError("Privacy policy name is invalid.");
      }
      if (
        this.history.db
          .prepare<
            [string],
            { present: number }
          >("SELECT 1 AS present FROM privacy_policy_families WHERE name_key = ?")
          .get(name.toLowerCase())
      ) {
        throw new PrivacyPolicyValidationError("A privacy policy with this name already exists.");
      }
      validatePolicy(input.policy);
      const document = await this.writeFamily(randomUUID(), input.policy, null, input.action, {
        familyName: name,
        originRevision: input.originRevision ?? null,
        originTemplateId: input.originTemplateId ?? null,
      });
      return { ...document, familyName: name };
    });
  }

  renameFamily(
    familyId: string,
    name: string,
  ): Promise<
    | Exclude<RenamePrivacyPolicyFamilyResult, { outcome: "renamed" }>
    | { outcome: "renamed"; document: PrivacyPolicyDocument }
  > {
    return this.serialized(async () => {
      if (!this.history) return { outcome: "not-found" };
      // The default family may not yet have its first immutable snapshot.
      if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) await this.readOrCreate();
      const result = await this.history.writeGate.renamePrivacyPolicyFamily(
        familyId,
        name,
        this.now(),
      );
      if (result.outcome !== "renamed") return result;
      const version = currentPrivacyPolicyVersion(this.history.db, familyId);
      if (!version) return { outcome: "not-found" };
      return {
        outcome: "renamed",
        document: this.document({ ...version, familyName: result.name }),
      };
    });
  }

  deleteFamily(familyId: string) {
    return this.serialized(async () => {
      if (!this.history) return { outcome: "not-found" } as const;
      return this.history.writeGate.deletePrivacyPolicyFamily(familyId, this.now());
    });
  }

  updateFamily(
    familyId: string,
    expectedRevision: string,
    mutate: (policy: string) => string | null,
  ): Promise<PrivacyPolicyDocument | null> {
    if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) return this.update(expectedRevision, mutate);
    return this.serialized(async () => {
      if (!this.history) return null;
      const family = this.history.db
        .prepare("SELECT 1 FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
        .get(familyId);
      if (!family) return null;
      const current = currentPrivacyPolicyVersion(this.history!.db, familyId);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PrivacyPolicyConflictError(this.document(current));
      }
      const policy = mutate(current.policy);
      if (policy === null) return null;
      validatePolicy(policy);
      return this.writeFamily(familyId, policy, expectedRevision, "edit");
    });
  }

  restoreFamily(
    familyId: string,
    expectedRevision: string,
    source: { policy: string; revision: string },
  ): Promise<PrivacyPolicyDocument> {
    if (!this.history) {
      return Promise.reject(
        new PrivacyPolicyValidationError("Privacy policy history is not available."),
      );
    }
    if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) {
      const generation = this.history!.db.prepare<[string], { generation: number }>(
        "SELECT generation FROM privacy_policy_versions WHERE revision = ?",
      ).get(source.revision)?.generation;
      if (!generation) throw new PrivacyPolicyValidationError("Privacy policy version not found.");
      return this.revert(expectedRevision, source.policy, generation);
    }
    return this.serialized(async () => {
      if (
        !this.history!.db.prepare(
          "SELECT 1 FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL",
        ).get(familyId)
      ) {
        throw new PrivacyPolicyValidationError("Privacy policy family not found.");
      }
      validatePolicy(source.policy);
      return this.writeFamily(familyId, source.policy, expectedRevision, "restore", {
        originRevision: source.revision,
      });
    });
  }

  /**
   * Rewrite the policy through `mutate`, which receives the effective text and
   * returns its replacement or null to refuse. Legacy syntax is projected in
   * memory on reads; the first explicit edit persists that projected form.
   *
   * Read, revision check, transform, and write all happen inside one turn of
   * the serialization queue. A caller that instead read with {@link get},
   * transformed, and wrote back through a second call would leave a gap between
   * the two turns. Revisions are opaque generation tokens, so every effective
   * change advances the compare-and-swap identity even when text recurs.
   */
  update(
    expectedRevision: string,
    mutate: (policy: string) => string | null,
  ): Promise<PrivacyPolicyDocument | null> {
    return this.serialized(async () => {
      const current = await this.readOrCreate();
      if (current.revision !== expectedRevision) {
        throw new PrivacyPolicyConflictError(current);
      }
      const next = mutate(current.policy);
      if (next === null) return null;
      validatePolicy(next);
      return this.write(next, expectedRevision, "edit", null);
    });
  }

  /**
   * Run an automatic release only while the reviewed policy revision is still
   * current. Policy writes share this serialization queue. The database release
   * also receives a synchronous file-revision guard so direct editor writes are
   * checked at its commit boundary.
   */
  runIfRevision<T>(expectedRevision: string, operation: () => Promise<T>): Promise<T | null> {
    return this.serialized(async () => {
      const current = await this.readOrCreate();
      if (current.revision !== expectedRevision) return null;
      return operation();
    });
  }

  /** Run only while one named family's exact published revision remains current. */
  runFamilyIfRevision<T>(
    familyId: string,
    expectedRevision: string,
    operation: (document: PrivacyPolicyDocument) => Promise<T>,
  ): Promise<T | null> {
    if (familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) {
      return this.serialized(async () => {
        const current = await this.readOrCreate();
        if (current.revision !== expectedRevision) return null;
        return operation(current);
      });
    }
    return this.serialized(async () => {
      if (!this.history) return null;
      const family = this.history.db
        .prepare<
          [string],
          { name: string }
        >("SELECT name FROM privacy_policy_families WHERE id = ? AND archived_at IS NULL")
        .get(familyId);
      const current = family ? currentPrivacyPolicyVersion(this.history.db, familyId) : null;
      if (!family || !current || current.revision !== expectedRevision) return null;
      return operation(this.document({ ...current, familyName: family.name }));
    });
  }

  private async readOrCreate(): Promise<PrivacyPolicyDocument> {
    if (this.history) return this.readOrReconcileHistory();
    try {
      return await this.readExisting();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await atomicWriteFile(this.path, DEFAULT_PRIVACY_POLICY, {
        mode: 0o600,
        ensureDir: true,
      });
      return this.readExisting();
    }
  }

  /** Append a revert as a new generation; the historical row is never made current in-place. */
  revert(
    expectedRevision: string,
    policy: string,
    revertedFromGeneration: number,
  ): Promise<PrivacyPolicyDocument> {
    return this.serialized(async () => {
      const current = await this.readOrCreate();
      if (current.revision !== expectedRevision) throw new PrivacyPolicyConflictError(current);
      validatePolicy(policy);
      return this.write(policy, expectedRevision, "revert", revertedFromGeneration);
    });
  }

  /**
   * The default family's name comes from its row like any other family's, so
   * what a review record says it was reviewed under is what the library shows.
   */
  private defaultFamilyName(): string | undefined {
    return this.history?.db
      .prepare<[string], { name: string }>("SELECT name FROM privacy_policy_families WHERE id = ?")
      .get(DEFAULT_PRIVACY_POLICY_FAMILY_ID)?.name;
  }

  private document(version: Parameters<typeof documentForVersion>[0]): PrivacyPolicyDocument {
    return documentForVersion(version, this.defaultFamilyName());
  }

  private async readOrReconcileHistory(): Promise<PrivacyPolicyDocument> {
    const stored = currentPrivacyPolicyVersion(this.history!.db);
    const state = currentPrivacyPolicyState(this.history!.db);
    let disk: Awaited<ReturnType<PrivacyPolicyStore["readDiskOrNull"]>> = null;
    try {
      disk = await this.readDiskOrNull();
    } catch (err) {
      // Once history exists, the database is authoritative. A malformed,
      // oversized, or unreadable mirror is drift to repair, not a reason to
      // make the durable policy unavailable.
      if (!stored) throw err;
    }
    if (stored && disk?.digest === stored.digest) {
      if (!state?.mirrorSynced) await this.markMirrorSynced(stored);
      return this.document(stored);
    }
    // A commit is durable before its mirror write. If we restart in that gap,
    // the disk still contains the prior digest: finish the interrupted mirror
    // rather than recording that stale file as a fresh external reversal.
    if (stored && state && !state.mirrorSynced && (!disk || disk.digest === state.previousDigest)) {
      await this.writeAndMarkMirror(stored);
      return this.document(stored);
    }
    // Once bootstrapped, the database is authoritative. The file is a
    // human-readable mirror, not a second authoring channel: repair any drift
    // from the current immutable snapshot instead of importing it.
    if (stored) {
      await this.writeAndMarkMirror(stored);
      return this.document(stored);
    }
    const effective = disk?.policy ?? DEFAULT_PRIVACY_POLICY;
    const normalized = normalizePolicy(effectivePrivacyPolicy(effective));
    validatePolicy(normalized);
    const digest = policyRevision(normalized);
    const input: CommitPrivacyPolicyInput = {
      policy: normalized,
      digest,
      // Preserve the pre-ledger content-hash revision at bootstrap so an
      // in-flight review from the previous binary remains valid.
      revision: disk?.legacyRevision ?? digest,
      expectedRevision: null,
      action: "bootstrap",
      revertedFromGeneration: null,
      createdAt: this.now(),
    };
    const result = await this.history!.writeGate.commitPrivacyPolicy(input);
    const version = result.version;
    if (result.outcome === "written") {
      await this.writeAndMarkMirror(version);
    }
    return this.document(version);
  }

  private async write(
    policy: string,
    expectedRevision?: string,
    action: "edit" | "revert" = "edit",
    revertedFromGeneration: number | null = null,
  ): Promise<PrivacyPolicyDocument> {
    if (!this.history) {
      await this.writeMirror(policy);
      return this.readExisting();
    }
    const normalized = normalizePolicy(effectivePrivacyPolicy(policy));
    const result = await this.history.writeGate.commitPrivacyPolicy({
      policy: normalized,
      digest: policyRevision(normalized),
      revision: this.nextRevision(),
      expectedRevision: expectedRevision ?? null,
      action,
      revertedFromGeneration,
      createdAt: this.now(),
    });
    if (result.outcome === "conflict") {
      throw new PrivacyPolicyConflictError(this.document(result.version));
    }
    if (result.outcome === "written") await this.writeAndMarkMirror(result.version);
    return this.document(result.version);
  }

  private async writeFamily(
    familyId: string,
    policy: string,
    expectedRevision: string | null,
    action: PrivacyPolicyVersionAction,
    provenance: {
      familyName?: string;
      originRevision?: string | null;
      originTemplateId?: string | null;
    } = {},
  ): Promise<PrivacyPolicyDocument> {
    const normalized = normalizePolicy(effectivePrivacyPolicy(policy));
    const result = await this.history!.writeGate.commitPrivacyPolicy({
      familyId,
      ...(provenance.familyName ? { familyName: provenance.familyName } : {}),
      policy: normalized,
      digest: policyRevision(normalized),
      revision: this.nextRevision(),
      expectedRevision,
      action,
      revertedFromGeneration: null,
      originRevision: provenance.originRevision ?? null,
      originTemplateId: provenance.originTemplateId ?? null,
      createdAt: this.now(),
    });
    if (result.outcome === "conflict") {
      throw new PrivacyPolicyConflictError(this.document(result.version));
    }
    return this.document(result.version);
  }

  private async writeAndMarkMirror(version: {
    policy: string;
    generation: number;
    digest: string;
  }): Promise<void> {
    await this.writeMirror(version.policy);
    await this.markMirrorSynced(version);
  }

  private async markMirrorSynced(version: { generation: number; digest: string }): Promise<void> {
    await this.history!.writeGate.markPrivacyPolicyMirrorSynced(version.generation, version.digest);
  }

  private async writeMirror(policy: string): Promise<void> {
    if (this.history?.mirrorWrite) {
      await this.history.mirrorWrite(this.path, normalizePolicy(policy));
      return;
    }
    await atomicWriteFile(this.path, normalizePolicy(policy), {
      mode: 0o600,
      ensureDir: true,
    });
  }

  private async readDiskOrNull(): Promise<{
    policy: string;
    digest: string;
    legacyRevision: string;
  } | null> {
    try {
      const storedPolicy = await readFile(this.path, "utf8");
      validatePolicyBasics(storedPolicy);
      const policy = normalizePolicy(effectivePrivacyPolicy(storedPolicy));
      validatePolicy(policy);
      return {
        policy,
        digest: policyRevision(policy),
        legacyRevision: policyRevision(storedPolicy),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private nextRevision(): string {
    return this.history?.revisionGen?.() ?? randomBytes(32).toString("hex");
  }

  private now(): number {
    return this.history?.now?.() ?? Date.now();
  }

  private async readExisting(): Promise<PrivacyPolicyDocument> {
    const [storedPolicy, info] = await Promise.all([readFile(this.path, "utf8"), stat(this.path)]);
    validatePolicyBasics(storedPolicy);
    const policy = effectivePrivacyPolicy(storedPolicy);
    validatePolicy(policy);
    return {
      policy,
      generation: 0,
      digest: policyRevision(policy),
      revision: policyRevision(policy),
      updatedAt: Math.trunc(info.mtimeMs),
      schema: parsePrivacyPolicySchema(policy),
    };
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function documentForVersion(
  version: {
    policy: string;
    generation: number;
    digest: string;
    revision: string;
    createdAt: number;
    familyId?: string;
    familyName?: string;
    familyVersion?: number;
  },
  defaultFamilyName?: string,
): PrivacyPolicyDocument {
  return {
    policy: version.policy,
    generation: version.generation,
    digest: version.digest,
    revision: version.revision,
    updatedAt: version.createdAt,
    schema: parsePrivacyPolicySchema(version.policy),
    familyId: version.familyId ?? DEFAULT_PRIVACY_POLICY_FAMILY_ID,
    ...(version.familyName
      ? { familyName: version.familyName }
      : (version.familyId === undefined || version.familyId === DEFAULT_PRIVACY_POLICY_FAMILY_ID) &&
          defaultFamilyName
        ? { familyName: defaultFamilyName }
        : {}),
    familyVersion: version.familyVersion ?? version.generation,
  };
}

/** Effective reviewer policy for both current and legacy on-disk documents. */
export function effectivePrivacyPolicy(policy: string): string {
  const withoutRule = removeLegacyWatchAutoApproval(policy);
  return migrateLegacyPrivacyPolicyTable(withoutRule)
    .replace(LEGACY_POLICY_SCOPE_PARAGRAPH, POLICY_SCOPE_PARAGRAPH)
    .replace(
      LEGACY_PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE,
      PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE,
    );
}

/** Remove closed legacy directive fences; malformed remnants are rejected after migration. */
function removeLegacyWatchAutoApproval(policy: string): string {
  const lines = policy.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index]!.match(/^( {0,3})(`{3,}|~{3,})omnesis-watch-auto-approval\s*$/);
    if (!open) {
      kept.push(lines[index]!);
      continue;
    }
    const marker = open[2]![0]!;
    const minimum = open[2]!.length;
    let close = index + 1;
    while (close < lines.length) {
      const candidate = lines[close]!.trim();
      if (
        candidate.length >= minimum &&
        [...candidate].every((character) => character === marker)
      ) {
        break;
      }
      close += 1;
    }
    if (close >= lines.length) {
      kept.push(lines[index]!);
      continue;
    }
    index = close;
  }
  return kept.join("\n");
}

export function policyRevision(policy: string): string {
  return createHash("sha256").update(effectivePrivacyPolicy(policy), "utf8").digest("hex");
}

function validatePolicy(policy: string): void {
  validatePolicyBasics(policy);
  if (policy.includes("omnesis-watch-auto-approval")) {
    throw new PrivacyPolicyValidationError(
      "Remove the obsolete omnesis-watch-auto-approval directive before using this policy.",
    );
  }
}

function validatePolicyBasics(policy: string): void {
  if (policy.trim().length === 0) {
    throw new PrivacyPolicyValidationError("Privacy policy must not be empty.");
  }
  if (policy.length > MAX_PRIVACY_POLICY_CHARS) {
    throw new PrivacyPolicyValidationError(
      `Privacy policy exceeds ${MAX_PRIVACY_POLICY_CHARS} characters.`,
    );
  }
  if (policy.includes("\0")) {
    throw new PrivacyPolicyValidationError("Privacy policy must not contain NUL characters.");
  }
}

function normalizePolicy(policy: string): string {
  return policy.endsWith("\n") ? policy : `${policy}\n`;
}

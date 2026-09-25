// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRIVACY_POLICY,
  PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE,
  PRIVACY_POLICY_DENY_FLOOR,
  PRIVACY_POLICY_THIRD_PARTY_SENTENCE,
  PRIVACY_POLICY_TEMPLATES,
  PrivacyPolicyConflictError,
  PrivacyPolicyStore,
  policyRevision,
} from "./policy-store.js";

const dirs: string[] = [];

async function makeStore(): Promise<PrivacyPolicyStore> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-privacy-policy-"));
  dirs.push(dir);
  return new PrivacyPolicyStore(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PrivacyPolicyStore", () => {
  it("creates the owner-only Markdown template when the file is absent", async () => {
    const store = await makeStore();
    const document = await store.get();

    expect(document.policy).toBe(DEFAULT_PRIVACY_POLICY);
    expect(document.policy).toContain(
      "| Schedule availability | Allow | Allow | Approval required |",
    );
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("preserves direct file edits and exposes a new revision", async () => {
    const store = await makeStore();
    const first = await store.get();
    await writeFile(store.path, "# My policy\n\nRequire approval for everything.\n", "utf8");

    const edited = await store.get();
    expect(edited.policy).toContain("Require approval for everything");
    expect(edited.revision).not.toBe(first.revision);
  });

  it("removes the legacy standing rule and upgrades its decision table", async () => {
    const store = await makeStore();
    const legacyPolicy = `# Legacy policy

| Information | Summary | Exact or original |
| --- | --- | --- |
| Messages and files | Release with reductions | Approval required |

\`\`\`omnesis-watch-auto-approval
integrations: 8f1b2c3d-4e5a-4b6c-9d7e-0f1a2b3c4d5e
categories: documents
\`\`\`
`;
    await writeFile(store.path, legacyPolicy, "utf8");
    const migrated = await store.get();
    expect(migrated.policy).not.toContain("omnesis-watch-auto-approval");
    expect(migrated.policy).toContain(
      "| Messages and files | Approval required | Release with reductions | Approval required |",
    );
    expect(migrated.schema?.rows[0]?.existence).toBe("approve");
    expect(migrated.revision).toBe(policyRevision(legacyPolicy));
    expect(await readFile(store.path, "utf8")).toBe(legacyPolicy);

    const persisted = await store.update(
      migrated.revision,
      (policy) => `${policy}\n# Saved edit\n`,
    );
    expect(persisted?.policy).toContain("# Saved edit");
    expect(await readFile(store.path, "utf8")).not.toContain("omnesis-watch-auto-approval");
  });

  it("never overwrites direct editor content while projecting a legacy policy", async () => {
    const store = await makeStore();
    const first =
      "# Legacy policy\n\n```omnesis-watch-auto-approval\nintegrations: fictional\n```\n";
    await writeFile(store.path, first, "utf8");
    await store.get();

    const editorSave = `${first}\nThe operator added this line in a direct editor.\n`;
    await writeFile(store.path, editorSave, "utf8");
    const projected = await store.get();

    expect(projected.policy).toContain("The operator added this line");
    expect(projected.policy).not.toContain("omnesis-watch-auto-approval");
    expect(await readFile(store.path, "utf8")).toBe(editorSave);
  });

  it("rejects an unclosed legacy directive instead of showing it to the reviewer", async () => {
    const store = await makeStore();
    await writeFile(
      store.path,
      "# Legacy policy\n\n```omnesis-watch-auto-approval\nintegrations: fictional\n",
      "utf8",
    );
    await expect(store.get()).rejects.toThrow("Remove the obsolete");
  });

  it("removes every closed legacy directive block", async () => {
    const store = await makeStore();
    await writeFile(
      store.path,
      "# Legacy policy\n\n```omnesis-watch-auto-approval\nintegrations: first\n```\n\n~~~omnesis-watch-auto-approval\nintegrations: second\n~~~\n",
      "utf8",
    );
    const migrated = await store.get();
    expect(migrated.policy).toContain("# Legacy policy");
    expect(migrated.policy).not.toContain("omnesis-watch-auto-approval");
  });

  it("updates atomically with optimistic concurrency", async () => {
    const store = await makeStore();
    const first = await store.get();
    const updated = (await store.update(
      first.revision,
      () => "# Revised\n\nAllow schedule summaries.",
    ))!;

    expect(updated.policy).toBe("# Revised\n\nAllow schedule summaries.\n");
    await expect(store.update(first.revision, () => "# Stale")).rejects.toBeInstanceOf(
      PrivacyPolicyConflictError,
    );
    expect(await readFile(store.path, "utf8")).toBe(updated.policy);
  });

  it("rejects blank policies", async () => {
    const store = await makeStore();
    const current = await store.get();
    await expect(store.update(current.revision, () => "   ")).rejects.toThrow("must not be empty");
  });

  describe("built-in templates", () => {
    it("offers all four templates with exactly one default", () => {
      expect(PRIVACY_POLICY_TEMPLATES.map((t) => t.id)).toEqual([
        "guarded",
        "balanced",
        "open",
        "unfiltered",
      ]);
      const defaults = PRIVACY_POLICY_TEMPLATES.filter((t) => t.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe("guarded");
    });

    it("starts a fresh install from the default (guarded) template", async () => {
      const store = await makeStore();
      const document = await store.get();
      const guarded = PRIVACY_POLICY_TEMPLATES.find((t) => t.isDefault);
      expect(document.policy).toBe(DEFAULT_PRIVACY_POLICY);
      expect(document.policy).toBe(guarded?.policy);
    });

    it("keeps the same deny floor in the three protective templates", () => {
      for (const template of PRIVACY_POLICY_TEMPLATES.filter(
        (candidate) => candidate.id !== "unfiltered",
      )) {
        // The shared floor section appears verbatim...
        expect(template.policy).toContain(PRIVACY_POLICY_DENY_FLOOR);
        // ...and the sensitive rows are Deny at exact detail in the table too.
        expect(template.policy).toMatch(/\| Health \|[^\n]+\| Deny \|/);
        expect(template.policy).toMatch(/\| Money and payment information \|[^\n]+\| Deny \|/);
        expect(template.policy).toMatch(/\| Identity documents \|[^\n]+\| Deny \|/);
        expect(template.policy).toContain(
          "| Passwords, authentication codes, tokens, private keys, and recovery codes | Deny | Deny | Deny |",
        );
      }
    });

    it("holds another person's contact, financial, and health details in every template", () => {
      for (const template of PRIVACY_POLICY_TEMPLATES) {
        expect(template.policy).toContain(PRIVACY_POLICY_THIRD_PARTY_SENTENCE);
      }
      expect(DEFAULT_PRIVACY_POLICY).toContain(PRIVACY_POLICY_THIRD_PARTY_SENTENCE);
      // The rule names what it holds and what it leaves to the table.
      for (const detail of [
        "phone numbers",
        "email addresses",
        "postal addresses",
        "financial account or card numbers",
        "health details",
      ]) {
        expect(PRIVACY_POLICY_THIRD_PARTY_SENTENCE).toContain(detail);
      }
      expect(PRIVACY_POLICY_THIRD_PARTY_SENTENCE).toContain(
        "a person's name alone, and your own contact details, follow the table",
      );
    });

    it("makes Unfiltered release full detail unchanged except for its three approval rows", () => {
      const template = PRIVACY_POLICY_TEMPLATES.find((candidate) => candidate.id === "unfiltered");
      expect(template).toBeDefined();
      const policy = template!.policy;
      expect(policy.split("\n").filter((line) => line.startsWith("| "))).toEqual([
        "| Information | Existence | Summary | Exact or original |",
        "| --- | --- | --- | --- |",
        "| All information not listed below | Allow | Allow | Allow |",
        "| Identity documents | Approval required | Approval required | Approval required |",
        "| Other people's contact, financial, and health details | Approval required | Approval required | Approval required |",
        "| Passwords, authentication codes, tokens, private keys, and recovery codes | Approval required | Approval required | Approval required |",
      ]);
      expect(policy).toContain("This rule is exhaustive.");
      expect(policy).toContain("require approval merely because a category is absent");
      expect(policy).toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
      expect(policy).not.toContain("Release with reductions");
      expect(policy).not.toContain("Deny");
      expect(policy).not.toContain(PRIVACY_POLICY_DENY_FLOOR);
    });

    it("makes each template adoptable through the store", async () => {
      for (const template of PRIVACY_POLICY_TEMPLATES) {
        const store = await makeStore();
        const current = await store.get();
        const saved = (await store.update(current.revision, () => template.policy))!;
        // Stored verbatim (normalizePolicy only ensures a trailing newline, which
        // composePolicy already emits), and each template is a distinct revision.
        expect(saved.policy).toBe(template.policy);
      }
      const revisions = new Set<string>();
      for (const template of PRIVACY_POLICY_TEMPLATES) {
        const store = await makeStore();
        const current = await store.get();
        revisions.add((await store.update(current.revision, () => template.policy))!.revision);
      }
      expect(revisions.size).toBe(PRIVACY_POLICY_TEMPLATES.length);
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  applyPrivacyPolicySchemaEdit,
  migrateLegacyPrivacyPolicyTable,
  parsePrivacyPolicySchema,
  readPrivacyPolicySchema,
} from "./policy-schema.js";
import {
  PRIVACY_POLICY_APPROVAL_SECTION_HEADING,
  PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE,
  PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE,
  PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE,
  PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
  PRIVACY_POLICY_TEMPLATES,
} from "./policy-store.js";

const GUARDED = PRIVACY_POLICY_TEMPLATES.find((template) => template.id === "guarded")!.policy;

describe("privacy policy schema", () => {
  it("parses every built-in template", () => {
    for (const template of PRIVACY_POLICY_TEMPLATES) {
      const schema = parsePrivacyPolicySchema(template.policy);
      expect(schema, template.id).not.toBeNull();
      expect(schema!.rows.length, template.id).toBeGreaterThan(0);
      for (const row of schema!.rows) {
        expect(row.label, template.id).not.toBe("");
      }
    }
  });

  it("conservatively upgrades the legacy table", () => {
    const legacy = `# Policy

| Information | Summary | Exact or original |
| --- | --- | --- |
| Schedule availability | Allow | Approval required |
| Location and addresses | Release with reductions | Approval required |
| Health | Deny | Deny |
`;
    const migrated = migrateLegacyPrivacyPolicyTable(legacy);
    expect(parsePrivacyPolicySchema(migrated)?.rows).toEqual([
      { label: "Schedule availability", existence: "allow", summary: "allow", exact: "approve" },
      {
        label: "Location and addresses",
        existence: "approve",
        summary: "reduce",
        exact: "approve",
      },
      { label: "Health", existence: "deny", summary: "deny", exact: "deny" },
    ]);
  });

  it("reads the table shape each template actually declares", () => {
    const guarded = parsePrivacyPolicySchema(
      PRIVACY_POLICY_TEMPLATES.find((template) => template.id === "guarded")!.policy,
    )!;
    expect(guarded.rows).toHaveLength(9);
    expect(guarded.rows[0]).toEqual({
      label: "Schedule availability",
      existence: "allow",
      summary: "allow",
      exact: "approve",
    });
    expect(guarded.rows.at(-1)!.summary).toBe("approve");

    // Unfiltered is not nine rows — the schema must follow the policy rather
    // than impose a fixed category list.
    const unfiltered = parsePrivacyPolicySchema(
      PRIVACY_POLICY_TEMPLATES.find((template) => template.id === "unfiltered")!.policy,
    )!;
    expect(unfiltered.rows).toHaveLength(4);
    expect(unfiltered.rows[0]!.label).toBe("All information not listed below");
  });

  it("rewrites only the table, leaving the prose around it byte for byte", () => {
    const original = PRIVACY_POLICY_TEMPLATES.find(
      (template) => template.id === "balanced",
    )!.policy;
    const edited = applyPrivacyPolicySchemaEdit(original, {
      row: "Health",
      summary: "deny",
    })!;
    expect(edited).not.toBe(original);

    const schema = parsePrivacyPolicySchema(edited)!;
    expect(schema.rows.find((row) => row.label === "Health")).toEqual({
      label: "Health",
      existence: "approve",
      summary: "deny",
      exact: "approve",
    });

    // Everything outside the table survives verbatim.
    const before = (policy: string) =>
      policy.slice(0, readPrivacyPolicySchema(policy)!.table.start);
    const after = (policy: string) => policy.slice(readPrivacyPolicySchema(policy)!.table.end);
    expect(before(edited)).toBe(before(original));
    expect(after(edited)).toBe(after(original));
  });

  it("keeps the splice range out of the projection clients receive", () => {
    // A range is this module's rewrite detail. Publishing it would invite a
    // client to splice policy text the grammar then has to read back.
    expect(Object.keys(parsePrivacyPolicySchema(GUARDED)!).sort()).toEqual([
      "credentialApprovalEnabled",
      "rows",
    ]);
  });

  it("is a no-op round trip when nothing changes", () => {
    for (const template of PRIVACY_POLICY_TEMPLATES) {
      const rows = parsePrivacyPolicySchema(template.policy)!.rows;
      const unchanged = applyPrivacyPolicySchemaEdit(template.policy, {
        row: rows[0]!.label,
        summary: rows[0]!.summary,
        exact: rows[0]!.exact,
      });
      expect(unchanged, template.id).toBe(template.policy);
    }
  });

  it("preserves prose the operator hand-wrote around the table", () => {
    const original = `${PRIVACY_POLICY_TEMPLATES[0]!.policy}\n## My own notes\n\nDo not release anything about my employer.\n`;
    const edited = applyPrivacyPolicySchemaEdit(original, { row: "Health", exact: "approve" })!;
    expect(edited).toContain("## My own notes");
    expect(edited).toContain("Do not release anything about my employer.");
  });

  it("adds and removes the credential clause as an exact line", () => {
    const blocked = applyPrivacyPolicySchemaEdit(GUARDED, { credentialApprovalEnabled: false })!;
    expect(blocked).not.toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);

    const enabled = applyPrivacyPolicySchemaEdit(blocked, { credentialApprovalEnabled: true })!;
    expect(enabled).toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
    expect(parsePrivacyPolicySchema(enabled)!.credentialApprovalEnabled).toBe(true);

    const disabled = applyPrivacyPolicySchemaEdit(enabled, { credentialApprovalEnabled: false })!;
    expect(disabled).not.toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
    expect(parsePrivacyPolicySchema(disabled)!.credentialApprovalEnabled).toBe(false);
  });

  it("never leaves the policy claiming credentials are both approvable and not", () => {
    const blocked = applyPrivacyPolicySchemaEdit(GUARDED, { credentialApprovalEnabled: false })!;
    expect(blocked).toContain(PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE);

    const enabled = applyPrivacyPolicySchemaEdit(blocked, { credentialApprovalEnabled: true })!;
    // The floor's own sentence is the one the reviewer reads right before the
    // opt-in. Leaving it would state the opposite in the adjacent paragraph.
    expect(enabled).not.toContain(PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE);
    expect(enabled).toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE);
    // And the clause lands under the section that collects approval
    // requirements, not appended below a floor that denies them.
    const lines = enabled.split("\n");
    const heading = lines.indexOf(PRIVACY_POLICY_APPROVAL_SECTION_HEADING);
    expect(heading).toBeGreaterThan(-1);
    expect(lines.indexOf(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE)).toBeGreaterThan(heading);

    const disabled = applyPrivacyPolicySchemaEdit(enabled, { credentialApprovalEnabled: false })!;
    expect(disabled).toBe(blocked);
    expect(enabled).toBe(GUARDED);
  });

  it("files the clause under an approval section the policy already has", () => {
    const unfiltered = PRIVACY_POLICY_TEMPLATES.find(
      (template) => template.id === "unfiltered",
    )!.policy;
    const disabled = applyPrivacyPolicySchemaEdit(unfiltered, {
      credentialApprovalEnabled: false,
    })!;
    // The section keeps the identity-document requirement it already carried.
    expect(disabled).toContain(PRIVACY_POLICY_APPROVAL_SECTION_HEADING);
    expect(disabled).toContain("Identity-document contents must be held");

    expect(applyPrivacyPolicySchemaEdit(disabled, { credentialApprovalEnabled: true })).toBe(
      unfiltered,
    );
  });

  describe("keeps the credentials row in step with the opt-in", () => {
    const credentialRow = (policy: string) =>
      parsePrivacyPolicySchema(policy)!.rows.find(
        (row) => row.label === PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
      );
    const toggle = (policy: string, credentialApprovalEnabled: boolean) =>
      applyPrivacyPolicySchemaEdit(policy, { credentialApprovalEnabled })!;

    it.each(PRIVACY_POLICY_TEMPLATES.map((template) => [template.id, template.policy] as const))(
      "%s: denies with the opt-in off, asks with it on, and round-trips",
      (_id, template) => {
        expect(credentialRow(template)).toMatchObject({
          existence: "approve",
          summary: "approve",
          exact: "approve",
        });

        const disabled = toggle(template, false);
        expect(parsePrivacyPolicySchema(disabled)!.credentialApprovalEnabled).toBe(false);
        expect(credentialRow(disabled)).toMatchObject({
          existence: "deny",
          summary: "deny",
          exact: "deny",
        });
        // Nothing left in the policy says a credential can be approved.
        expect(disabled).not.toContain(PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE);

        const enabled = toggle(disabled, true);
        expect(credentialRow(enabled)).toMatchObject({
          existence: "approve",
          summary: "approve",
          exact: "approve",
        });
        expect(enabled).toBe(template);

        // Repeating either edit changes nothing further.
        expect(toggle(disabled, false)).toBe(disabled);
        expect(toggle(enabled, true)).toBe(enabled);
        expect(toggle(toggle(enabled, false), true)).toBe(template);
      },
    );

    it("tightens an approval cell on an already disabled policy", () => {
      const disabled = toggle(GUARDED, false);
      const contradictory = disabled.replace(
        `| ${PRIVACY_POLICY_CREDENTIAL_ROW_LABEL} | Deny | Deny | Deny |`,
        `| ${PRIVACY_POLICY_CREDENTIAL_ROW_LABEL} | Approval required | Approval required | Approval required |`,
      );
      expect(contradictory).not.toBe(disabled);
      expect(toggle(contradictory, false)).toBe(disabled);
    });

    it("leaves a row the operator shaped otherwise as written where the gate allows it", () => {
      const customised = applyPrivacyPolicySchemaEdit(GUARDED, {
        row: PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
        existence: "allow",
        summary: "reduce",
      })!;

      const disabled = toggle(customised, false);
      // Only the cell that promised approval changes; what may be said about a
      // credential is not something the gate blocks.
      expect(credentialRow(disabled)).toMatchObject({
        existence: "allow",
        summary: "reduce",
        exact: "deny",
      });

      // A deny the operator kept beside other decisions is never loosened.
      const enabled = toggle(disabled, true);
      expect(credentialRow(enabled)).toMatchObject({
        existence: "allow",
        summary: "reduce",
        exact: "deny",
      });
      expect(parsePrivacyPolicySchema(enabled)!.credentialApprovalEnabled).toBe(true);
    });

    it("denies the exact credential value however the row allowed it", () => {
      const allowed = applyPrivacyPolicySchemaEdit(GUARDED, {
        row: PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
        exact: "allow",
      })!;
      expect(credentialRow(toggle(allowed, false))).toMatchObject({ exact: "deny" });
    });

    it("never loosens a Deny the operator chose while the opt-in is on", () => {
      const denied = applyPrivacyPolicySchemaEdit(GUARDED, {
        row: PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
        existence: "deny",
        summary: "deny",
        exact: "deny",
      })!;
      // Re-sending an opt-in that is already on changes nothing.
      expect(toggle(denied, true)).toBe(denied);
    });

    it("keeps the row a request sets while turning the opt-in on", () => {
      const disabled = toggle(GUARDED, false);
      const edited = applyPrivacyPolicySchemaEdit(disabled, {
        row: PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
        existence: "deny",
        summary: "deny",
        exact: "deny",
        credentialApprovalEnabled: true,
      })!;
      expect(parsePrivacyPolicySchema(edited)!.credentialApprovalEnabled).toBe(true);
      expect(credentialRow(edited)).toMatchObject({
        existence: "deny",
        summary: "deny",
        exact: "deny",
      });
    });

    it("denies a row a request sets to approval while turning the opt-in off", () => {
      const edited = applyPrivacyPolicySchemaEdit(GUARDED, {
        row: PRIVACY_POLICY_CREDENTIAL_ROW_LABEL,
        existence: "approve",
        summary: "approve",
        exact: "approve",
        credentialApprovalEnabled: false,
      })!;
      expect(credentialRow(edited)).toMatchObject({
        existence: "deny",
        summary: "deny",
        exact: "deny",
      });
    });

    it("leaves a renamed credentials row alone", () => {
      const renamed = GUARDED.replace(PRIVACY_POLICY_CREDENTIAL_ROW_LABEL, "Secrets");
      const disabled = toggle(renamed, false);
      expect(parsePrivacyPolicySchema(disabled)!.rows.at(-1)).toEqual({
        label: "Secrets",
        existence: "approve",
        summary: "approve",
        exact: "approve",
      });
    });
  });

  it("reports the credential opt-in the deterministic gate actually matches", () => {
    const unfiltered = PRIVACY_POLICY_TEMPLATES.find((template) => template.id === "unfiltered")!;
    expect(parsePrivacyPolicySchema(unfiltered.policy)!.credentialApprovalEnabled).toBe(true);
  });

  it("fails open rather than guessing at policies it cannot read", () => {
    expect(parsePrivacyPolicySchema("# Just prose, no table at all")).toBeNull();
    // Two tables: which one drives the controls is ambiguous.
    const template = PRIVACY_POLICY_TEMPLATES[0]!.policy;
    expect(parsePrivacyPolicySchema(`${template}\n${template}`)).toBeNull();
    // A decision word the legend never defines.
    expect(
      parsePrivacyPolicySchema(
        template.replace("| Health | Approval required |", "| Health | Maybe |"),
      ),
    ).toBeNull();
  });

  it("reads the alignment colons GFM tables are allowed to carry", () => {
    const aligned = GUARDED.replace("| --- | --- | --- |", "|:---|:---:|---:|");
    expect(parsePrivacyPolicySchema(aligned)!.rows).toEqual(
      parsePrivacyPolicySchema(GUARDED)!.rows,
    );
  });

  it("checks every separator cell, not only the first", () => {
    const ragged = GUARDED.replace("| --- | --- | --- |", "| --- | Allow | --- |");
    expect(parsePrivacyPolicySchema(ragged)).toBeNull();
  });

  it("refuses a table whose labels are not unique", () => {
    // Two rows answering to one name make every edit a coin flip: the edit
    // would silently change whichever came first.
    const duplicated = GUARDED.replace(
      "| General preferences | Allow | Allow | Approval required |",
      "| Schedule availability | Allow | Allow | Approval required |",
    );
    expect(parsePrivacyPolicySchema(duplicated)).toBeNull();
    expect(
      applyPrivacyPolicySchemaEdit(duplicated, { row: "Schedule availability", summary: "deny" }),
    ).toBeNull();
  });

  it("addresses a row by how its label displays, not by how it is encoded", () => {
    // The same word, decomposed in the policy and composed in the edit. They
    // render identically, so a client that read one must be able to name the
    // other.
    const decomposed = "Sante\u0301 et bien-e\u0302tre";
    const composed = decomposed.normalize("NFC");
    expect(composed).not.toBe(decomposed);

    const policy = GUARDED.replace("| Health |", `| ${decomposed} |`);
    expect(parsePrivacyPolicySchema(policy)!.rows.map((row) => row.label)).toContain(composed);

    const edited = applyPrivacyPolicySchemaEdit(policy, { row: composed, summary: "allow" })!;
    expect(
      parsePrivacyPolicySchema(edited)!.rows.find((row) => row.label === composed)!.summary,
    ).toBe("allow");
  });

  it("refuses an edit naming a row the table does not have", () => {
    const template = PRIVACY_POLICY_TEMPLATES[0]!.policy;
    expect(
      applyPrivacyPolicySchemaEdit(template, { row: "Nonexistent", summary: "allow" }),
    ).toBeNull();
    expect(
      applyPrivacyPolicySchemaEdit("# no table", { credentialApprovalEnabled: true }),
    ).toBeNull();
  });
});

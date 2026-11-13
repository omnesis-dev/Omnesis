// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { canonicalScopePolicies, parseScopePolicyV1, scopePolicyV1Schema } from "./scope-policy.js";
import type { ScopePolicy, SourceScopes } from "@omnesis/types";

const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
    { kind: "participant", identifiers: ["phone"], link: "changes" },
  ],
};
const policy = {
  sourceId: "fictional-account",
  audience: { accessLevel: "fictional-level", capability: "direct" },
  rules: [{ match: [{ kind: "conversation", id: "chat-1" }], action: "share" }],
  otherwise: "hide",
};

describe("V1 scope policy boundary", () => {
  it("matches native email canonicalization for typed aliases", () => {
    const result = parseScopePolicyV1(
      {
        ...policy,
        rules: [
          {
            action: "hide",
            match: [
              {
                kind: "participant",
                label: "Fictional contact",
                identifiers: [{ type: "email", value: "fictional.scope.check+filter@gmail.com" }],
              },
            ],
          },
        ],
        otherwise: "share",
      },
      { items: [{ kind: "participant", identifiers: ["email"], link: "fixed" }] },
    );
    expect(result.rules[0]?.match[0]).toEqual({
      kind: "participant",
      label: "Fictional contact",
      identifiers: [{ type: "email", value: "fictionalscopecheck@gmail.com" }],
    });
  });

  it("canonicalizes unordered lists without mutating saved data or ordered rules", () => {
    const input: ScopePolicy[] = [
      {
        sourceId: "second",
        audience: { accessLevel: "level", capability: "direct" },
        rules: [
          {
            action: "hide",
            match: [
              {
                kind: "participant",
                label: "Contact",
                identifiers: [
                  { type: "phone", value: "+15550100123" },
                  { type: "email", value: "contact@example.org" },
                ],
              },
              { kind: "conversation", id: "chat" },
            ],
          },
          { action: "share", match: [{ kind: "conversation", id: "exception" }] },
        ],
        otherwise: "hide",
      },
      {
        sourceId: "first",
        audience: { accessLevel: "level", capability: "direct" },
        rules: [],
        otherwise: "share",
      },
    ];
    const before = JSON.stringify(input);
    const canonical = canonicalScopePolicies(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(canonical.map((item) => item.sourceId)).toEqual(["first", "second"]);
    expect(canonical[1]?.rules.map((rule) => rule.action)).toEqual(["hide", "share"]);
    expect(canonical[1]?.rules[0]?.match.map((ref) => ref.kind)).toEqual([
      "conversation",
      "participant",
    ]);
    expect(canonicalScopePolicies(canonical)).toEqual(canonical);
  });

  it("accepts both list modes and mixed kinds", () => {
    expect(parseScopePolicyV1(policy, scopes)).toEqual(policy);
    const excluded = {
      ...policy,
      rules: [
        {
          action: "hide",
          match: [
            { kind: "conversation", id: "chat-1" },
            {
              kind: "participant",
              label: "Fictional contact",
              identifiers: [{ type: "phone", value: "+15550100123" }],
            },
          ],
        },
      ],
      otherwise: "share",
    };
    expect(parseScopePolicyV1(excluded, scopes)).toEqual(excluded);
  });

  it.each([
    { ...policy, maxAge: "90d" },
    { ...policy, audience: "keep" },
    { ...policy, audience: "brain" },
    { ...policy, rules: [...policy.rules, ...policy.rules] },
    { ...policy, rules: [] },
    { ...policy, otherwise: "share" },
    ...["ask", "keep", "drop"].map((action) => ({
      ...policy,
      rules: [{ ...policy.rules[0], action }],
    })),
    { ...policy, unexpected: true },
  ])("refuses reserved V2 fields and unsupported list shapes (%j)", (input) => {
    expect(scopePolicyV1Schema.safeParse(input).success).toBe(false);
  });

  it("preserves opaque IDs exactly and accepts empty lists", () => {
    const input = {
      ...policy,
      rules: [{ action: "share", match: [{ kind: "conversation", id: " opaque ID " }] }],
    };
    expect(parseScopePolicyV1(input, scopes).rules[0]?.match[0]).toEqual({
      kind: "conversation",
      id: " opaque ID ",
    });
    expect(
      scopePolicyV1Schema.safeParse({ ...policy, rules: [{ action: "share", match: [] }] }).success,
    ).toBe(true);
  });

  it("bounds aggregate identifiers before SQL compilation", () => {
    const identifiers = Array.from({ length: 129 }, () => ({
      type: "phone",
      value: "+15550100123",
    }));
    const ref = { kind: "participant", label: "Contact", identifiers };
    expect(
      scopePolicyV1Schema.safeParse({ ...policy, rules: [{ action: "share", match: [ref, ref] }] })
        .success,
    ).toBe(false);
  });

  it("refuses undeclared item kinds and identifier types", () => {
    expect(() => parseScopePolicyV1(policy, { items: [] })).toThrow(/conversation/);
    expect(() =>
      parseScopePolicyV1(
        {
          ...policy,
          rules: [
            {
              action: "share",
              match: [
                {
                  kind: "participant",
                  label: "Fictional contact",
                  identifiers: [{ type: "email", value: "contact@example.org" }],
                },
              ],
            },
          ],
        },
        scopes,
      ),
    ).toThrow(/email/);
  });

  it.each(["opaque@lid", "15550100123", "+12", "(555) 010-0123", "+44 (0)7700 900123"])(
    "rejects invalid phone identifier %s",
    (value) => {
      expect(
        scopePolicyV1Schema.safeParse({
          ...policy,
          rules: [
            {
              action: "share",
              match: [
                {
                  kind: "participant",
                  label: "Fictional contact",
                  identifiers: [{ type: "phone", value }],
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("normalizes email and domain identifiers, preserving stable item IDs", () => {
    const parsed = parseScopePolicyV1(
      {
        ...policy,
        rules: [
          {
            action: "share",
            match: [
              {
                kind: "participant",
                label: "Fictional contact",
                identifiers: [
                  { type: "email", value: "CONTACT@EXAMPLE.ORG" },
                  { type: "domain", value: "EXAMPLE.ORG" },
                ],
              },
            ],
          },
        ],
      },
      { items: [{ kind: "participant", identifiers: ["email", "domain"], link: "changes" }] },
    );
    expect(parsed.rules[0]?.match[0]).toEqual({
      kind: "participant",
      label: "Fictional contact",
      identifiers: [
        { type: "email", value: "contact@example.org" },
        { type: "domain", value: "example.org" },
      ],
    });
  });

  it("saves the canonical spelling of an identifier however it was typed", () => {
    const parsed = parseScopePolicyV1(
      {
        ...policy,
        rules: [
          {
            action: "hide",
            match: [
              {
                kind: "participant",
                label: "Fictional contact",
                identifiers: [
                  { type: "phone", value: "+1 (555) 010-0123" },
                  { type: "phone", value: "0015550100124" },
                  { type: "email", value: "Fictional Contact <Contact@Example.ORG>" },
                  { type: "domain", value: "@Example.ORG" },
                ],
              },
            ],
          },
        ],
        otherwise: "share",
      },
      {
        items: [
          { kind: "participant", identifiers: ["phone", "email", "domain"], link: "changes" },
        ],
      },
    );
    expect(parsed.rules[0]?.match[0]).toMatchObject({
      identifiers: [
        { type: "phone", value: "+15550100123" },
        { type: "phone", value: "+15550100124" },
        { type: "email", value: "contact@example.org" },
        { type: "domain", value: "example.org" },
      ],
    });
  });

  it.each(["example..org", "example.org/path", "*.example.org", "example.org.evil/", "localhost"])(
    "rejects invalid domain %s",
    (value) => {
      expect(
        scopePolicyV1Schema.safeParse({
          ...policy,
          rules: [
            {
              action: "hide",
              match: [
                {
                  kind: "participant",
                  label: "Fictional domain",
                  identifiers: [{ type: "domain", value }],
                },
              ],
            },
          ],
          otherwise: "share",
        }).success,
      ).toBe(false);
    },
  );
});

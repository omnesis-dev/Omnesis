// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }
  function generate(input: string, options?: GenerateOptions): void;
  function generate(input: string, options: GenerateOptions, cb: (rendered: string) => void): void;
  function generate(input: string, cb: (rendered: string) => void): void;

  const _default: { generate: typeof generate };
  export default _default;
  export { generate };
}

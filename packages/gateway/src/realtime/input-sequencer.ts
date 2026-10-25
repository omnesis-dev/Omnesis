// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface PendingInput {
  committed: boolean;
  transcript?: string;
  timeout: ReturnType<typeof setTimeout>;
}

/** ASR completions may arrive out of order; committed audio defines conversation order. */
export class RealtimeInputSequencer {
  private readonly pending = new Map<string, PendingInput>();
  private readonly committed: string[] = [];
  private readonly completed = new Set<string>();
  constructor(
    private readonly deliver: (text: string, id: string) => void,
    private readonly fail: () => void,
  ) {}

  commit(id: string): void {
    if (this.completed.has(id)) return;
    const input = this.input(id);
    if (!input.committed) {
      input.committed = true;
      this.committed.push(id);
    }
    this.drain();
  }
  transcribe(id: string, transcript: string): void {
    if (this.completed.has(id)) return;
    const input = this.input(id);
    if (input.transcript === undefined) input.transcript = transcript;
    this.drain();
  }
  private input(id: string): PendingInput {
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 4 || this.completed.size >= 256)
      throw new Error("Realtime input limit reached");
    const timeout = setTimeout(this.fail, 30_000);
    timeout.unref();
    const input = { committed: false, timeout };
    this.pending.set(id, input);
    return input;
  }
  private drain(): void {
    while (this.committed.length) {
      const id = this.committed[0]!;
      const input = this.pending.get(id)!;
      if (input.transcript === undefined) return;
      this.committed.shift();
      this.pending.delete(id);
      this.completed.add(id);
      clearTimeout(input.timeout);
      if (input.transcript) this.deliver(input.transcript, id);
    }
  }
  dispose(): void {
    for (const input of this.pending.values()) clearTimeout(input.timeout);
    this.pending.clear();
    this.committed.length = 0;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

function toolLabel(value: string): string {
  const labels: Record<string, string> = {
    search_documents: "Searching documents",
    search_many: "Searching documents",
    fetch_document: "Reading a document",
    fetch_many: "Reading documents",
    run_sql: "Querying records",
    lookup_people: "Finding people",
    trace_connections: "Following connections",
    temporal_query: "Searching dates",
    lookup_document_by_url: "Finding a source link",
    present_browser_results: "Presenting results",
  };
  return Object.hasOwn(labels, value) ? labels[value]! : value.replace(/_/g, " ");
}
export interface FindToolCard {
  id: string;
  tool: string;
  summary: string;
  status: "preparing" | "running" | "done" | "error";
  result?: string;
}
/** Live bounded tool cards are deliberately separate from the durable search result. */
export class FindProgress {
  private readonly cards = new Map<string, FindToolCard>();
  update(type: string, payload: Record<string, unknown>): boolean {
    if (
      !["agent.tool.input_start", "agent.tool.start", "agent.tool.result"].includes(type) ||
      typeof payload.toolCallId !== "string"
    )
      return false;
    const id = payload.toolCallId.slice(0, 128);
    let card = this.cards.get(id);
    if (!card) {
      if (this.cards.size >= 20) this.cards.delete(this.cards.keys().next().value!);
      card = {
        id,
        tool: typeof payload.tool === "string" ? toolLabel(payload.tool.slice(0, 128)) : "Tool",
        summary: "",
        status: "preparing",
      };
      this.cards.set(id, card);
    }
    if (type === "agent.tool.input_start") card.status = "preparing";
    else if (type === "agent.tool.start") {
      card.status = "running";
      card.tool =
        typeof payload.tool === "string" ? toolLabel(payload.tool.slice(0, 128)) : card.tool;
      card.summary =
        typeof payload.argsSummary === "string"
          ? payload.argsSummary.slice(0, 500)
          : typeof payload.intent === "string"
            ? payload.intent.slice(0, 500)
            : "";
    } else if (type === "agent.tool.result") {
      const result =
        payload.result && typeof payload.result === "object"
          ? (payload.result as Record<string, unknown>)
          : {};
      card.status = result.kind === "error" || result.error ? "error" : "done";
      const data =
        result.data && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : {};
      card.result =
        typeof result.message === "string"
          ? result.message.slice(0, 1000)
          : typeof data.count === "number" && Number.isInteger(data.count) && data.count >= 0
            ? `${data.count} ${data.count === 1 ? "result" : "results"} ready`
            : Array.isArray(result.results)
              ? `${result.results.length} ${result.results.length === 1 ? "result" : "results"} found`
              : Array.isArray(result.rows)
                ? `${result.rows.length} ${result.rows.length === 1 ? "record" : "records"} returned`
                : "Completed";
    } else return false;
    return true;
  }
  snapshot(): FindToolCard[] {
    return [...this.cards.values()].map((card) => ({ ...card }));
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AssistantMarkdown, createAgentToolRenderer, h, render } from "@omnesis/gateway/agent-ui";
import type { FindView } from "./find-service.js";

/** The portal's actual transcript components, with only browser-safe metadata injected. */
export function createFindConversation(
  host: HTMLElement,
  flush: (toolCallId: string, progressId?: string) => void,
) {
  let view: FindView | undefined;
  const tools = createAgentToolRenderer({
    sourceIcon(sourceId, options) {
      if (typeof sourceId !== "string") return "📄";
      const type = sourceId.split(":")[0] ?? sourceId;
      const icon = view?.sourceIcons?.[sourceId] ?? view?.sourceIcons?.[type];
      if (!icon) return "📄";
      const size = options?.size ?? 16;
      return h("img", {
        src: icon,
        alt: "",
        width: size,
        height: size,
        style: { objectFit: "contain" },
      });
    },
  });
  return {
    render(next?: FindView): void {
      view = next;
      const parts = next?.tools;
      const visible = parts?.some((part) =>
        part.kind === "text" ? !!part.text : !part.tailDismissed,
      );
      host.hidden = !next || (!visible && !next.agentText);
      if (host.hidden) {
        render(null, host);
        return;
      }
      const children = parts?.length
        ? parts.map((part, index) =>
            part.kind === "text"
              ? h(AssistantMarkdown, {
                  key: index,
                  text: part.text ?? "",
                  copyable: !next?.running,
                  blockImages: true,
                })
              : part.kind === "tool"
                ? tools.renderToolPart(part, part.toolCallId ?? index, (action) =>
                    flush(action.toolCallId, next?.progressId),
                  )
                : null,
          )
        : h(AssistantMarkdown, {
            text: next?.agentText ?? "",
            copyable: !next?.running,
            blockImages: true,
          });
      render(
        h(
          "div",
          { class: "agent-msg-assistant", key: next?.progressId ?? "restored" },
          h("div", { class: "agent-msg-body" }, children),
        ),
        host,
      );
    },
  };
}

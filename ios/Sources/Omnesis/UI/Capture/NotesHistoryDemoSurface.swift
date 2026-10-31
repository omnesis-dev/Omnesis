// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension CaptureView {
    func historyPreview(_ model: NotesHistoryModel) -> Self {
        var copy = self
        copy.previewHistoryModel = model
        return copy
    }
}

/// Keep this navigation harness outside the generic gesture-demo container so
/// its real drawer owns capture's right-swipe, as it does in the app shell.
@available(iOS 17.0, *)
struct NotesDemoRootOverride: ViewModifier {
    let isNotes: Bool

    func body(content: Content) -> some View {
        if isNotes {
            NotesHistoryDemoSurface()
                .environment(AppStore.preview())
                .environment(\.appearanceStore, AppearanceStore(mode: .dark))
        } else {
            content
        }
    }
}

/// The real capture and history views over a stateful, in-process transport.
/// UI tests can edit, delete and undo without recording audio or contacting a gateway.
@available(iOS 17.0, *)
struct NotesHistoryDemoSurface: View {
    @State private var model: NotesHistoryModel
    @State private var menuOpen = true
    @State private var selection: HomeTab = .search
    @State private var captureOpen = false

    init() {
        let entries = ProcessInfo.processInfo.environment["DEMO_NOTES_PENDING_RECEIPT"] == "1"
            ? [PreviewMocks.noteHistoryTranscribingWithResponse] : PreviewMocks.noteHistory
        let session = NotesHistoryDemoSession(entries: entries)
        let base = URL(string: "https://gateway.example.com")!
        _model = State(initialValue: NotesHistoryModel(
            client: NotesClient(baseURL: base, token: "preview", session: session),
            tasks: TasksClient(baseURL: base, token: "preview", session: session)
        ))
    }

    var body: some View {
        if ProcessInfo.processInfo.environment["DEMO_NOTES_MENU"] == "1" {
            menuSurface
        } else {
            CaptureView(
                speech: .preview(state: .listening, transcript: PreviewMocks.noteHistoryCaptureDraft),
                previewText: PreviewMocks.noteHistoryCaptureDraft
            ).historyPreview(model)
        }
    }

    private var menuSurface: some View {
        MenuRevealContainer(isOpen: $menuOpen) {
            MainMenuDrawer(
                isOpen: $menuOpen,
                selection: $selection,
                onOpenSettings: {},
                onSelectDestination: { captureOpen = false }
            )
        } content: {
            if captureOpen {
                CaptureView(onClose: { captureOpen = false }, speech: .preview(state: .listening))
                    .historyPreview(model)
            } else if selection == .notes {
                NotesHistoryScreen(model: model, menuOpen: $menuOpen)
            } else {
                Theme.bgPrimary.ignoresSafeArea()
            }
        }
        .environment(\.openCapture) {
            captureOpen = true
            menuOpen = false
        }
        .onChange(of: selection) { _, _ in captureOpen = false }
    }
}

@available(iOS 17.0, *)
private actor NotesHistoryDemoSession: URLSessionLike {
    private var entries: [NoteEntry]
    private var undone = false

    init(entries: [NoteEntry]) {
        self.entries = entries
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url!
        let path = url.path
        var status = 200
        let data: Data
        if request.httpMethod == "GET", path == "/notes/history" {
            struct Page: Encodable {
                let entries: [NoteEntry]
                let pageInfo = ["hasMore": false]
            }
            data = try JSONEncoder().encode(Page(entries: entries))
        } else if request.httpMethod == "GET", path == "/notes" {
            struct Day: Encodable { let entries: [NoteEntry] }
            let day = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "day" }?.value
            data = try JSONEncoder().encode(Day(entries: entries.filter { $0.day == day }))
        } else if request.httpMethod == "PATCH", let index = entries.firstIndex(where: { path == "/notes/\($0.id)" }) {
            struct Edit: Decodable { let text: String }
            let body = try JSONDecoder().decode(Edit.self, from: request.httpBody ?? Data())
            guard var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entries[index])) as? [String: Any]
            else { throw GatewayClient.Error.invalidResponse }
            fields["text"] = body.text
            fields["updatedAt"] = "2026-06-12T11:00:00.000Z"
            fields.removeValue(forKey: "transcription")
            fields.removeValue(forKey: "transcribedAt")
            entries[index] = try JSONDecoder().decode(NoteEntry.self, from: JSONSerialization.data(withJSONObject: fields))
            // The real PATCH is a bare entry; the model retains its historical agent receipt.
            fields.removeValue(forKey: "agent")
            data = try JSONSerialization.data(withJSONObject: fields)
        } else if request.httpMethod == "DELETE", let index = entries.firstIndex(where: { path == "/notes/\($0.id)" }) {
            entries.remove(at: index)
            status = 204
            data = Data()
        } else if request.httpMethod == "POST", path == "/tasks/undo", !undone {
            struct Undo: Decodable { let seq: Int }
            let body = try JSONDecoder().decode(Undo.self, from: request.httpBody ?? Data())
            guard body.seq == 42 else { throw GatewayClient.Error.invalidResponse }
            undone = true
            data = Data(#"{"task":null,"receipt":{"text":"Reversed the workshop task change","undoSeq":null}}"#.utf8)
        } else {
            status = 404
            data = Data(#"{"error":"not_found"}"#.utf8)
        }
        return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

#Preview("Notes interactions") {
    NotesHistoryDemoSurface().environment(AppStore.preview())
}
#endif

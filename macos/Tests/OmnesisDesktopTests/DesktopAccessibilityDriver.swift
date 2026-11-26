// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import ApplicationServices
import XCTest

@MainActor
enum DesktopAccessibilityDriver {
    /// AppKit's reparenting proxies implement public selectors without nominal protocol conformance.
    /// Objective-C dynamic lookup preserves that supported dispatch; no external AX process is used.
    private static var diagnosticsWritten = false
    @MainActor
    struct Element {
        let object: AnyObject
        private func attribute(_ name: NSAccessibility.Attribute) -> Any? {
            object.accessibilityAttributeValue?(name) ?? nil
        }

        func accessibilityIdentifier() -> String? {
            object.accessibilityIdentifier?() ?? attribute(.identifier) as? String
        }

        func accessibilityLabel() -> String? {
            object.accessibilityLabel?() ?? attribute(.description) as? String ?? attribute(.title) as? String
        }

        func accessibilityValue() -> Any? {
            object.accessibilityValue?() ?? attribute(.value)
        }

        func accessibilityFrame() -> NSRect {
            object.accessibilityFrame?() ?? .zero
        }

        func accessibilityTextValue() -> String? {
            switch accessibilityValue() {
            case let text as String: text
            case let text as NSAttributedString: text.string
            default: nil
            }
        }

        func accessibilityChildren() -> [Any] {
            let children = object.accessibilityChildren?() ?? []
            return children.isEmpty ? (attribute(.children) as? [Any] ?? []) : children
        }

        func accessibilityRole() -> NSAccessibility.Role? {
            if let role = object.accessibilityRole?() { return role }
            return (attribute(.role) as? String).map(NSAccessibility.Role.init(rawValue:))
        }

        func isAccessibilityEnabled() -> Bool {
            object.isAccessibilityEnabled?() ?? attribute(.enabled) as? Bool ?? false
        }

        func accessibilityPerformPress() -> Bool {
            let named: (() -> Void)? = if let actions = object.accessibilityActionNames?(), actions.contains(.press),
                                          let press = object.accessibilityPerformAction {
                { press(.press) }
            } else { nil }
            return DesktopAccessibilityDriver.performOnePress(named: named, direct: object.accessibilityPerformPress)
        }
    }

    /// A forwarding AppKit control must receive one action, even if a direct selector returns false.
    static func performOnePress(named: (() -> Void)?, direct: (() -> Bool)?) -> Bool {
        if let named { named()
            return true
        }
        return direct?() ?? false
    }

    private static var bootstrapComplete = false
    static func materializeOwnedApplication() async throws {
        guard !bootstrapComplete else { return }
        let evidence = await Task.detached {
            // Fixed self PID only; never create the system-wide element or request trust.
            let application = AXUIElementCreateApplication(getpid())
            let timeout = AXUIElementSetMessagingTimeout(application, 1)
            var count = 0
            let status = timeout == .success
                ? AXUIElementGetAttributeValueCount(application, kAXWindowsAttribute as CFString, &count) : timeout
            return "self=true timeoutStatus=\(timeout.rawValue) readStatus=\(status.rawValue) windows=\(count)"
        }.value
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try evidence.write(to: output.appendingPathComponent("owned-accessibility-bootstrap.txt"), atomically: true, encoding: .utf8)
        bootstrapComplete = true
    }

    /// Traverse only the mounted test view and its exact owning window.
    static func elements(in root: NSView) throws -> [Element] {
        // Flush only this mounted view's pending layout/display before reading lazy AX nodes.
        // A screenshot does this too; reading the controls must not depend on taking one first.
        root.layoutSubtreeIfNeeded()
        root.window?.displayIfNeeded()
        var pending: [Any] = [root]
        if let window = root.window { pending.append(window) }
        var seen: Set<ObjectIdentifier> = []
        var result: [Element] = []
        while let next = pending.popLast() {
            guard result.count < 4096 else { throw Failure("The owned accessibility tree exceeded its bound") }
            let object = next as AnyObject
            guard seen.insert(ObjectIdentifier(object)).inserted else { continue }
            let element = Element(object: object)
            result.append(element)
            pending.append(contentsOf: element.accessibilityChildren())
            if let view = object as? NSView { pending.append(contentsOf: view.subviews) }
        }
        return result
    }

    static func element(_ identifier: String, in root: NSView) throws -> Element {
        guard let control = try elements(in: root).first(where: { $0.accessibilityIdentifier() == identifier }) else {
            try writeDiagnostics(root)
            throw Failure("Missing visible control: \(identifier)")
        }
        return control
    }

    static func press(_ identifier: String, in root: NSView) throws {
        let control = try element(identifier, in: root)
        guard control.isAccessibilityEnabled() else { throw Failure("The user control must be enabled") }
        XCTAssertTrue(control.accessibilityPerformPress(), "The actual accessible action must be triggered")
    }

    static func type(_ value: String, into identifier: String, in root: NSView) throws {
        let control = try element(identifier, in: root)
        guard control.isAccessibilityEnabled() else { throw Failure("The user control must be enabled") }
        control.object.setAccessibilityFocused?(true)
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let fields = descendants(root).compactMap { $0 as? NSTextField }
            .filter { $0.isEditable && !$0.isHiddenOrHasHiddenAncestor }
        // The production composer has one native editable field. Enter through its actual editor
        // so AppKit sends the same edit notifications as user typing, rather than only changing AXValue.
        guard fields.count == 1, let field = fields.first, let window = field.window else {
            throw Failure("The identified user input has no unique editable native control")
        }
        guard window.makeFirstResponder(field) else { throw Failure("The owned text control refused focus") }
        field.selectText(nil)
        guard let editor = field.currentEditor() as? NSTextView else { throw Failure("The owned text editor is unavailable") }
        editor.insertText(value, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        XCTAssertEqual(editor.string, value)
    }

    static func contains(_ text: String, in root: NSView) throws -> Bool {
        try elements(in: root).contains {
            ($0.accessibilityLabel() ?? "").contains(text) || ($0.accessibilityTextValue() ?? "").contains(text)
        }
    }

    static func writeDiagnostics(_ root: NSView) throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let destination = output.appendingPathComponent("owned-accessibility-tree.txt")
        guard !diagnosticsWritten else { return }
        let lines = try elements(in: root).map { element in
            let object = element.object
            let value = element.accessibilityValue()
            let valueType = value.map { String(reflecting: Swift.type(of: $0)) } ?? "nil"
            let text = String((element.accessibilityTextValue() ?? "").prefix(240)).replacingOccurrences(of: "\n", with: "\\n")
            return "\(String(reflecting: Swift.type(of: object))) id=\(element.accessibilityIdentifier() ?? "-") role=\(element.accessibilityRole()?.rawValue ?? "-") label=\(element.accessibilityLabel() ?? "-") valueType=\(valueType) text=\(text) children=\(element.accessibilityChildren().count)"
        }
        try lines.joined(separator: "\n").write(to: destination, atomically: true, encoding: .utf8)
        diagnosticsWritten = true
    }

    struct Failure: Error { let message: String
        init(_ message: String) {
            self.message = message
        }
    }
}

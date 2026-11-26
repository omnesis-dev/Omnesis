// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Checks archive framing without extracting names or retaining file contents.
public struct DesktopTarCompletion {
    public enum Failure: LocalizedError {
        case invalid, incomplete
        public var errorDescription: String? {
            "The download was incomplete or damaged. No copy was saved."
        }
    }

    private var header: [UInt8] = []
    private var payload: UInt64 = 0
    private var padding = 0
    private var zeroBlocks = 0
    private var trailing = 0
    private var failed = false

    public init() {
        header.reserveCapacity(512)
    }

    public mutating func append(_ bytes: Data) throws {
        guard !failed else { throw Failure.invalid }
        do { try consume(bytes) }
        catch { failed = true
            throw error
        }
    }

    private mutating func consume(_ bytes: Data) throws {
        var index = bytes.startIndex
        while index < bytes.endIndex {
            let available = bytes.distance(from: index, to: bytes.endIndex)
            if zeroBlocks == 2 {
                guard bytes[index...].allSatisfy({ $0 == 0 }) else { throw Failure.invalid }
                trailing = (trailing + available % 512) % 512
                return
            }
            if payload > 0 {
                let count = Int(min(payload, UInt64(available)))
                payload -= UInt64(count)
                index = bytes.index(index, offsetBy: count)
                continue
            }
            if padding > 0 {
                let count = min(padding, available)
                let end = bytes.index(index, offsetBy: count)
                guard bytes[index ..< end].allSatisfy({ $0 == 0 }) else { throw Failure.invalid }
                padding -= count
                index = end
                continue
            }
            let count = min(512 - header.count, available)
            let end = bytes.index(index, offsetBy: count)
            header.append(contentsOf: bytes[index ..< end])
            index = end
            if header.count == 512 {
                try acceptHeader()
                header.removeAll(keepingCapacity: true)
            }
        }
    }

    public func finish() throws {
        guard !failed, zeroBlocks == 2, header.isEmpty, payload == 0, padding == 0, trailing == 0 else {
            throw Failure.incomplete
        }
    }

    private mutating func acceptHeader() throws {
        if header.allSatisfy({ $0 == 0 }) {
            zeroBlocks += 1
            return
        }
        guard zeroBlocks == 0 else { throw Failure.invalid }
        let checksum = header.enumerated().reduce(UInt64(0)) { sum, item in
            sum + UInt64((148 ..< 156).contains(item.offset) ? 32 : item.element)
        }
        guard try number(header[148 ..< 156], binary: false) == checksum else { throw Failure.invalid }
        payload = try number(header[124 ..< 136], binary: true)
        padding = Int((512 - payload % 512) % 512)
    }

    private func number(_ bytes: ArraySlice<UInt8>, binary: Bool) throws -> UInt64 {
        var digits = Array(bytes)
        var radix: UInt64 = 8
        if binary, let first = digits.first, first & 0x80 != 0 {
            guard first & 0x40 == 0 else { throw Failure.invalid }
            digits[0] &= 0x7F
            radix = 256
        } else {
            while digits.first == 0 || digits.first == 32 {
                digits.removeFirst()
            }
            while digits.last == 0 || digits.last == 32 {
                digits.removeLast()
            }
            guard digits.allSatisfy({ (48 ... 55).contains($0) }) else { throw Failure.invalid }
            digits = digits.map { $0 - 48 }
        }
        var value: UInt64 = 0
        for digit in digits {
            let product = value.multipliedReportingOverflow(by: radix)
            let sum = product.partialValue.addingReportingOverflow(UInt64(digit))
            guard !product.overflow, !sum.overflow else { throw Failure.invalid }
            value = sum.partialValue
        }
        return value
    }
}

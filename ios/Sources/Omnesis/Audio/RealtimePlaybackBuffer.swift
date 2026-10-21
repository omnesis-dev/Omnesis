// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// PCM stays in memory; only a small window is handed to the audio player.
struct RealtimePlaybackBuffer {
    static let sampleRate: Int64 = 24000

    struct Packet {
        let token: Int
        let data: Data
        let startFrame: Int64
        var frameCount: Int64 {
            Int64(data.count / 2)
        }
    }

    struct Truncation: Equatable {
        let itemID: String
        let audioEndMilliseconds: Int
    }

    private struct Chunk {
        var data: Data
        let itemID: String?
        let itemOffset: Int64
        var consumed = 0
    }

    private struct Scheduled {
        let token: Int
        let itemID: String?
        let itemOffset: Int64
        let start: Int64
        let count: Int64
    }

    private struct Item {
        var received: Int64 = 0
        var completed: Int64 = 0
    }

    let windowFrames: Int64
    let maximumBytes: Int
    private var chunks: [Chunk] = []
    private var scheduled: [Scheduled] = []
    private var items: [String: Item] = [:]
    private var itemOrder: [String] = []
    private var nextToken = 0
    private var timelineEnd: Int64 = 0
    private(set) var retainedPCMBytes = 0
    private(set) var scheduledFrames: Int64 = 0

    init(maximumBytes: Int = 32 * 1024 * 1024, windowFrames: Int64 = 48000) {
        self.maximumBytes = maximumBytes
        self.windowFrames = windowFrames
    }

    var isEmpty: Bool {
        chunks.isEmpty && scheduled.isEmpty
    }

    /// Reserve the float32 scheduling window and bounded chunk/item bookkeeping.
    private var maximumPCMBytes: Int {
        max(0, maximumBytes - Int(windowFrames * 4) - 256 * 1024)
    }

    mutating func append(_ data: Data, itemID: String?) -> Bool {
        guard !data.isEmpty, data.count.isMultiple(of: 2) else { return true }
        guard data.count <= maximumPCMBytes - retainedPCMBytes else { return false }
        if let itemID, items[itemID] == nil {
            guard items.count < 512 else { return false }
            items[itemID] = Item()
            itemOrder.append(itemID)
        }
        let offset = itemID.flatMap { items[$0]?.received } ?? 0
        if let itemID { items[itemID]!.received += Int64(data.count / 2) }
        retainedPCMBytes += data.count
        // Coalesce small deltas so metadata also has a fixed bound.
        var consumed = 0
        while consumed < data.count {
            if let last = chunks.indices.last, chunks[last].itemID == itemID,
               chunks[last].consumed == 0, chunks[last].data.count < 32768 {
                let count = min(32768 - chunks[last].data.count, data.count - consumed)
                chunks[last].data.append(data.subdata(in: consumed ..< consumed + count))
                consumed += count
            } else {
                let count = min(32768, data.count - consumed)
                chunks.append(Chunk(
                    data: data.subdata(in: consumed ..< consumed + count),
                    itemID: itemID,
                    itemOffset: offset + Int64(consumed / 2)
                ))
                consumed += count
            }
        }
        return true
    }

    mutating func nextPacket(renderedFrame: Int64, leadFrames: Int64 = 240) -> Packet? {
        guard !chunks.isEmpty, scheduledFrames < windowFrames else { return nil }
        let available = (chunks[0].data.count - chunks[0].consumed) / 2
        let count = min(Int64(available), min(2400, windowFrames - scheduledFrames))
        let offset = chunks[0].consumed
        let data = chunks[0].data.subdata(in: offset ..< offset + Int(count * 2))
        let start = max(timelineEnd, max(0, renderedFrame) + leadFrames)
        nextToken += 1
        scheduled.append(Scheduled(
            token: nextToken,
            itemID: chunks[0].itemID,
            itemOffset: chunks[0].itemOffset + Int64(offset / 2),
            start: start,
            count: count
        ))
        chunks[0].consumed += Int(count * 2)
        if chunks[0].consumed == chunks[0].data.count {
            retainedPCMBytes -= chunks.removeFirst().data.count
        }
        timelineEnd = start + count
        scheduledFrames += count
        return Packet(token: nextToken, data: data, startFrame: start)
    }

    @discardableResult
    mutating func complete(token: Int) -> Bool {
        guard let index = scheduled.firstIndex(where: { $0.token == token }) else { return false }
        let packet = scheduled.remove(at: index)
        scheduledFrames -= packet.count
        if let id = packet.itemID {
            items[id]!.completed = max(items[id]!.completed, packet.itemOffset + packet.count)
        }
        return true
    }

    /// The caller supplies the rendered player cursor minus presentation latency.
    func truncations(at audibleFrame: Int64) -> [Truncation] {
        itemOrder.compactMap { id in
            guard let item = items[id] else { return nil }
            let heard = heardFrames(itemID: id, at: audibleFrame)
            guard heard < item.received else { return nil }
            return Truncation(itemID: id, audioEndMilliseconds: Int(heard * 1000 / Self.sampleRate))
        }
    }

    func truncation(itemID: String, at audibleFrame: Int64) -> Truncation {
        Truncation(itemID: itemID, audioEndMilliseconds: Int(heardFrames(itemID: itemID, at: audibleFrame) * 1000 / Self.sampleRate))
    }

    private func heardFrames(itemID: String, at audibleFrame: Int64) -> Int64 {
        scheduled.filter { $0.itemID == itemID }.reduce(items[itemID]?.completed ?? 0) { result, packet in
            guard audibleFrame >= packet.start else { return result }
            return max(result, packet.itemOffset + min(packet.count, max(0, audibleFrame - packet.start)))
        }
    }

    mutating func reset() {
        chunks.removeAll()
        scheduled.removeAll()
        items.removeAll()
        itemOrder.removeAll()
        retainedPCMBytes = 0
        scheduledFrames = 0
        timelineEnd = 0
        // Tokens remain unique across resets so a late completion cannot consume new audio.
    }
}

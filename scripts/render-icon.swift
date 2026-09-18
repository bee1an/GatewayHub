#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 4 else {
    fputs("usage: render-icon.swift SOURCE.svg OUTPUT.iconset OUTPUT.icns\n", stderr)
    exit(2)
}

let sourcePath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let icnsPath = CommandLine.arguments[3]
let sourceURL = URL(fileURLWithPath: sourcePath)
let outputURL = URL(fileURLWithPath: outputPath)

guard let source = NSImage(contentsOf: sourceURL) else {
    fputs("cannot load SVG: \(sourcePath)\n", stderr)
    exit(1)
}

try? FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

struct IconSize {
    let name: String
    let pixels: Int
}

let sizes = [
    IconSize(name: "icon_16x16", pixels: 16),
    IconSize(name: "icon_16x16@2x", pixels: 32),
    IconSize(name: "icon_32x32", pixels: 32),
    IconSize(name: "icon_32x32@2x", pixels: 64),
    IconSize(name: "icon_128x128", pixels: 128),
    IconSize(name: "icon_128x128@2x", pixels: 256),
    IconSize(name: "icon_256x256", pixels: 256),
    IconSize(name: "icon_256x256@2x", pixels: 512),
    IconSize(name: "icon_512x512", pixels: 512),
    IconSize(name: "icon_512x512@2x", pixels: 1024),
]

for size in sizes {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size.pixels,
        pixelsHigh: size.pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fputs("cannot allocate bitmap: \(size.name)\n", stderr)
        exit(1)
    }

    let pointSize = NSSize(width: size.pixels, height: size.pixels)
    bitmap.size = pointSize
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fputs("cannot create graphics context: \(size.name)\n", stderr)
        exit(1)
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: pointSize).fill()
    source.draw(
        in: NSRect(origin: .zero, size: pointSize),
        from: NSRect(origin: .zero, size: source.size),
        operation: .sourceOver,
        fraction: 1
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fputs("cannot encode PNG: \(size.name)\n", stderr)
        exit(1)
    }
    try png.write(to: outputURL.appendingPathComponent("\(size.name).png"))
}

// Build the ICNS container directly from the PNG representations. This keeps
// the icon target self-contained on macOS and avoids depending on a GUI
// thumbnailer that may flatten SVG transparency onto a checkerboard/white
// matte before iconutil sees it.
struct IconResource {
    let type: String
    let file: String
}

let resources = [
    IconResource(type: "ic07", file: "icon_128x128.png"),
    IconResource(type: "ic08", file: "icon_256x256.png"),
    IconResource(type: "ic09", file: "icon_512x512.png"),
    IconResource(type: "ic10", file: "icon_512x512@2x.png"),
    IconResource(type: "ic11", file: "icon_16x16@2x.png"),
    IconResource(type: "ic12", file: "icon_32x32@2x.png"),
    IconResource(type: "ic13", file: "icon_256x256@2x.png"),
    IconResource(type: "ic14", file: "icon_512x512@2x.png"),
]

let payloads = try resources.map { resource in
    (resource.type, try Data(contentsOf: outputURL.appendingPathComponent(resource.file)))
}
let tocLength = 8 + payloads.count * 8
let totalLength = 8 + tocLength + payloads.reduce(0) { $0 + 8 + $1.1.count }
var icns = Data()

func appendUInt32(_ value: Int, to data: inout Data) {
    var number = UInt32(value).bigEndian
    data.append(Data(bytes: &number, count: MemoryLayout<UInt32>.size))
}

func appendFourCC(_ value: String, to data: inout Data) {
    data.append(contentsOf: value.utf8)
}

appendFourCC("icns", to: &icns)
appendUInt32(totalLength, to: &icns)
appendFourCC("TOC ", to: &icns)
appendUInt32(tocLength, to: &icns)
for (type, payload) in payloads {
    appendFourCC(type, to: &icns)
    appendUInt32(payload.count + 8, to: &icns)
}
for (type, payload) in payloads {
    // Each ICNS resource body repeats its own type and length before payload.
    appendFourCC(type, to: &icns)
    appendUInt32(payload.count + 8, to: &icns)
    icns.append(payload)
}
try icns.write(to: URL(fileURLWithPath: icnsPath))

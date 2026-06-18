#!/usr/bin/env swift
import Foundation
import ImageIO
import CoreGraphics

enum Resample: String {
    case auto
    case nearest
    case smooth
}

struct Representation: Encodable {
    let role: String
    let uti: String
    let width: Double
    let height: Double
    let byteCount: Int
    let preferred: Bool
    let index: Int
    let path: String
}

struct EncodeResult: Encodable {
    let mode: String
    let sourceWidth: Int
    let sourceHeight: Int
    let frameCount: Int
    let upscale: Bool
    let resample: String
    let representations: [Representation]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

struct Options {
    var input: String?
    var outputDir: String?
    var maxEdge = 768
    var noUpscale = false
    var resample = Resample.auto
}

func parseOptions() -> Options {
    var options = Options()
    var index = 1
    let args = CommandLine.arguments
    while index < args.count {
        let arg = args[index]
        switch arg {
        case "--input":
            index += 1
            guard index < args.count else { fail("--input requires a path") }
            options.input = args[index]
        case "--output-dir":
            index += 1
            guard index < args.count else { fail("--output-dir requires a path") }
            options.outputDir = args[index]
        case "--no-upscale":
            options.noUpscale = true
        case "--max-edge":
            index += 1
            guard index < args.count else { fail("--max-edge requires a pixel size") }
            guard let value = Int(args[index]), value >= 2 else {
                fail("--max-edge must be an integer of 2 or larger")
            }
            options.maxEdge = value
        case "--resample":
            index += 1
            guard index < args.count else { fail("--resample requires nearest, smooth, or auto") }
            guard let value = Resample(rawValue: args[index]) else {
                fail("--resample must be nearest, smooth, or auto")
            }
            options.resample = value
        default:
            fail("unknown helper argument: \(arg)")
        }
        index += 1
    }
    return options
}

func fileSize(_ path: String) -> Int {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attrs[.size] as? NSNumber else {
        fail("unable to read encoded file size: \(path)")
    }
    return size.intValue
}

func fitSize(width: Int, height: Int, maxEdge: Int, upscale: Bool) -> (Int, Int) {
    var scale = Double(maxEdge) / Double(max(width, height))
    if !upscale {
        scale = min(scale, 1.0)
    }
    return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
}

func renderedImage(_ image: CGImage, width: Int, height: Int, resample: Resample) -> CGImage {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpace(name: CGColorSpace.displayP3) else {
        fail("unable to create color space")
    }
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        fail("unable to create bitmap context")
    }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = resample == .nearest ? .none : .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let result = context.makeImage() else {
        fail("unable to render image")
    }
    return result
}

func writeImage(_ image: CGImage, type: String, outputURL: URL, quality: Double) {
    guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, type as CFString, 1, nil) else {
        fail("unable to create \(type) destination")
    }
    let props: [CFString: Any] = [
        kCGImageDestinationLossyCompressionQuality: quality
    ]
    CGImageDestinationAddImage(destination, image, props as CFDictionary)
    if !CGImageDestinationFinalize(destination) {
        fail("failed to write \(outputURL.path)")
    }
}

func frameDelay(_ source: CGImageSource, index: Int) -> Double {
    guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any] else {
        return 0.1
    }
    if let gif = props[kCGImagePropertyGIFDictionary] as? [CFString: Any] {
        if let unclamped = gif[kCGImagePropertyGIFUnclampedDelayTime] as? Double, unclamped >= 0.01 {
            return unclamped
        }
        if let delay = gif[kCGImagePropertyGIFDelayTime] as? Double, delay >= 0.01 {
            return delay
        }
    }
    if let heics = props[kCGImagePropertyHEICSDictionary] as? [CFString: Any] {
        if let unclamped = heics[kCGImagePropertyHEICSUnclampedDelayTime] as? Double, unclamped >= 0.01 {
            return unclamped
        }
        if let delay = heics[kCGImagePropertyHEICSDelayTime] as? Double, delay >= 0.01 {
            return delay
        }
    }
    return 0.1
}

func resolvedResample(_ requested: Resample, sourceURL: URL, width: Int, height: Int, isAnimated: Bool) -> Resample {
    if requested != .auto {
        return requested
    }
    let ext = sourceURL.pathExtension.lowercased()
    if isAnimated && ext == "gif" && max(width, height) <= 256 {
        return .nearest
    }
    return .smooth
}

func encodeStatic(source: CGImageSource, sourceURL: URL, outputDir: URL, maxEdge: Int, noUpscale: Bool, requestedResample: Resample) -> EncodeResult {
    guard let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("unable to read source image")
    }
    let resample = resolvedResample(requestedResample, sourceURL: sourceURL, width: sourceImage.width, height: sourceImage.height, isAnimated: false)
    let stillEdge = maxEdge
    let previewEdge = max(maxEdge, 320)
    let specs: [(String, Int, Bool, Int, Bool)] = [
        ("com.apple.stickers.role.still", stillEdge, true, 0, true),
        ("com.apple.stickers.role.keyboard", 100, false, 1, false),
        ("com.apple.stickers.role.stillVariant_320", previewEdge, false, 2, true),
        ("com.apple.stickers.role.stillVariant_160", 160, false, 3, false),
        ("com.apple.stickers.role.stillVariant_96", 96, false, 4, false),
        ("com.apple.stickers.role.stillVariant_64", 64, false, 5, false),
        ("com.apple.stickers.role.stillVariant_40", 40, false, 6, false)
    ]
    var reps: [Representation] = []
    for (role, repMaxEdge, preferred, repIndex, canUpscale) in specs {
        let (width, height) = fitSize(
            width: sourceImage.width,
            height: sourceImage.height,
            maxEdge: repMaxEdge,
            upscale: canUpscale && !noUpscale
        )
        let rendered = renderedImage(sourceImage, width: width, height: height, resample: resample)
        let outputURL = outputDir.appendingPathComponent("rep-\(repIndex).heic")
        writeImage(rendered, type: "public.heic", outputURL: outputURL, quality: 0.9)
        reps.append(Representation(
            role: role,
            uti: "public.heic",
            width: Double(width),
            height: Double(height),
            byteCount: fileSize(outputURL.path),
            preferred: preferred,
            index: repIndex,
            path: outputURL.path
        ))
    }
    return EncodeResult(
        mode: "static",
        sourceWidth: sourceImage.width,
        sourceHeight: sourceImage.height,
        frameCount: 1,
        upscale: !noUpscale,
        resample: resample.rawValue,
        representations: reps
    )
}

func encodeAnimated(source: CGImageSource, sourceURL: URL, outputDir: URL, maxEdge: Int, noUpscale: Bool, requestedResample: Resample) -> EncodeResult {
    let count = CGImageSourceGetCount(source)
    guard count > 1 else {
        fail("animated import requires at least two frames")
    }
    guard let firstImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("unable to read first animation frame")
    }
    let resample = resolvedResample(requestedResample, sourceURL: sourceURL, width: firstImage.width, height: firstImage.height, isAnimated: true)
    let (width, height) = fitSize(width: firstImage.width, height: firstImage.height, maxEdge: maxEdge, upscale: !noUpscale)
    let outputURL = outputDir.appendingPathComponent("animated.heics")

    guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.heics" as CFString, count, nil) else {
        fail("unable to create public.heics destination")
    }
    let destinationProperties: [CFString: Any] = [
        kCGImagePropertyHEICSDictionary: [
            kCGImagePropertyHEICSLoopCount: 0
        ],
        kCGImageDestinationLossyCompressionQuality: 0.85
    ]
    CGImageDestinationSetProperties(destination, destinationProperties as CFDictionary)

    for index in 0..<count {
        guard let frame = CGImageSourceCreateImageAtIndex(source, index, nil) else {
            fail("unable to read animation frame \(index)")
        }
        let rendered = renderedImage(frame, width: width, height: height, resample: resample)
        let frameProperties: [CFString: Any] = [
            kCGImagePropertyHEICSDictionary: [
                kCGImagePropertyHEICSDelayTime: max(frameDelay(source, index: index), 0.01)
            ],
            kCGImageDestinationLossyCompressionQuality: 0.85
        ]
        CGImageDestinationAddImage(destination, rendered, frameProperties as CFDictionary)
    }
    if !CGImageDestinationFinalize(destination) {
        fail("failed to write \(outputURL.path)")
    }

    return EncodeResult(
        mode: "animated",
        sourceWidth: firstImage.width,
        sourceHeight: firstImage.height,
        frameCount: count,
        upscale: !noUpscale,
        resample: resample.rawValue,
        representations: [
            Representation(
                role: "com.apple.stickers.role.animated",
                uti: "public.heics",
                width: Double(width),
                height: Double(height),
                byteCount: fileSize(outputURL.path),
                preferred: true,
                index: 2,
                path: outputURL.path
            )
        ]
    )
}

let options = parseOptions()
guard let input = options.input else { fail("--input is required") }
guard let outputDir = options.outputDir else { fail("--output-dir is required") }

let inputURL = URL(fileURLWithPath: input)
let outputURL = URL(fileURLWithPath: outputDir)
try? FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil) else {
    fail("unable to open image: \(input)")
}

let frameCount = CGImageSourceGetCount(source)
let result = frameCount > 1
    ? encodeAnimated(source: source, sourceURL: inputURL, outputDir: outputURL, maxEdge: options.maxEdge, noUpscale: options.noUpscale, requestedResample: options.resample)
    : encodeStatic(source: source, sourceURL: inputURL, outputDir: outputURL, maxEdge: options.maxEdge, noUpscale: options.noUpscale, requestedResample: options.resample)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(result)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)

// Run from the repository root on macOS: swift scripts/generate-own-branding.swift
import AppKit

let destination = URL(fileURLWithPath: "apps/android/smarttubetv/src/stown/res/mipmap-nodpi")
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let background = NSColor(srgbRed: 0.06, green: 0.09, blue: 0.12, alpha: 1)
let accent = NSColor(srgbRed: 0.32, green: 0.91, blue: 0.73, alpha: 1)

func render(_ name: String, width: Int, height: Int, icon: Bool = false, muted: Bool = false) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                 isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    background.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()

    let size: CGFloat = icon ? 180 : 64
    let x: CGFloat = icon ? (CGFloat(width) - size) / 2 : 25
    let y = (CGFloat(height) - size) / 2
    let color = muted ? NSColor.lightGray : accent
    color.setStroke()
    let ring = NSBezierPath(ovalIn: NSRect(x: x, y: y, width: size, height: size))
    ring.lineWidth = icon ? 16 : 6
    ring.stroke()
    color.setFill()
    let play = NSBezierPath()
    play.move(to: NSPoint(x: x + size * 0.42, y: y + size * 0.29))
    play.line(to: NSPoint(x: x + size * 0.42, y: y + size * 0.71))
    play.line(to: NSPoint(x: x + size * 0.73, y: y + size * 0.50))
    play.close()
    play.fill()

    if !icon {
        let title = "OwnTube" as NSString
        title.draw(at: NSPoint(x: 105, y: 76), withAttributes: [
            .font: NSFont.systemFont(ofSize: 38, weight: .bold),
            .foregroundColor: NSColor.white
        ])
        ("YOUR FEED. YOUR RULES." as NSString).draw(at: NSPoint(x: 108, y: 56), withAttributes: [
            .font: NSFont.systemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: color,
            .kern: 0.8
        ])
    }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name + ".png"))
}

try render("app_banner", width: 320, height: 180)
try render("app_logo", width: 320, height: 180)
try render("app_logo_semi_red", width: 320, height: 180)
try render("app_logo_semi_grey", width: 320, height: 180, muted: true)
try render("app_icon", width: 320, height: 320, icon: true)
try render("app_icon_alt", width: 320, height: 320, icon: true)

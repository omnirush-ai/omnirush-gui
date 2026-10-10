// Renders the macOS installer window background in the desktop app's own
// style (slate surfaces, the omnirush mark, system-font type) at 1x and @2x:
//
//   swift apps/desktop/scripts/dmg-background.swift [output-dir]
//
// Run it on a Mac (the type is SF Pro, the app's UI font) and commit the two
// PNGs it writes to apps/desktop/build/. The layout must match `dmg` in
// apps/desktop/electron-builder.yml: a 660x400 window, the app icon centred
// at (170, 190) and the Applications link at (490, 190).
import AppKit

let width: CGFloat = 660
let height: CGFloat = 400
let appIcon = CGPoint(x: 170, y: 190)
let applicationsIcon = CGPoint(x: 490, y: 190)

func hex(_ value: UInt32) -> NSColor {
  NSColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255,
    green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255,
    alpha: 1)
}

// The app's light theme (Radix slate, apps/app/src/styles/colors.css). Finder
// draws the icon labels black on a picture background in Light and Dark Mode
// alike, so a dark background would hide them.
let surfaceTop = hex(0xfcfcfd)  // slate-1
let surfaceBottom = hex(0xf0f0f3)  // slate-3
let ink = hex(0x1c2024)  // slate-12
let muted = hex(0x60646c)  // slate-11
let arrowColour = hex(0x8b8d98)  // slate-9

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let desktopDir = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let outputDir =
  CommandLine.arguments.count > 1
  ? URL(fileURLWithPath: CommandLine.arguments[1])
  : desktopDir.appendingPathComponent("build")
let markURL = desktopDir.appendingPathComponent("../app/public/omnirush-mark.png").standardizedFileURL
guard let mark = NSImage(contentsOf: markURL) else { fatalError("missing \(markURL.path)") }

func tinted(_ image: NSImage, _ colour: NSColor) -> NSImage {
  let out = NSImage(size: image.size)
  out.lockFocus()
  let rect = NSRect(origin: .zero, size: image.size)
  image.draw(in: rect)
  colour.set()
  rect.fill(using: .sourceAtop)
  out.unlockFocus()
  return out
}

func render(scale: CGFloat) -> Data {
  let pixelsWide = Int(width * scale)
  let pixelsHigh = Int(height * scale)
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
  else { fatalError("bitmap") }
  rep.size = NSSize(width: width, height: height)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current?.imageInterpolation = .high

  // AppKit's origin is bottom-left; layout below is in top-left points.
  func y(_ top: CGFloat) -> CGFloat { height - top }

  NSGradient(starting: surfaceTop, ending: surfaceBottom)?
    .draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

  // Header: the mark beside the product name, as on the app's welcome card.
  let markSize: CGFloat = 22
  let header = NSAttributedString(
    string: "omnirush.ai",
    attributes: [
      .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
      .foregroundColor: ink,
      .kern: -0.2,
    ])
  let gap: CGFloat = 9
  let headerWidth = markSize + gap + header.size().width
  let headerLeft = (width - headerWidth) / 2
  let headerMid: CGFloat = 54
  tinted(mark, ink).draw(
    in: NSRect(x: headerLeft, y: y(headerMid + markSize / 2), width: markSize, height: markSize))
  header.draw(
    at: NSPoint(
      x: headerLeft + markSize + gap,
      y: y(headerMid) - header.size().height / 2 + 1))

  // Arrow between the two icons, in the app's line-icon style.
  let arrow = NSBezierPath()
  let arrowFrom = appIcon.x + 108
  let arrowTo = applicationsIcon.x - 108
  let head: CGFloat = 11
  arrow.move(to: NSPoint(x: arrowFrom, y: y(appIcon.y)))
  arrow.line(to: NSPoint(x: arrowTo, y: y(appIcon.y)))
  arrow.move(to: NSPoint(x: arrowTo - head, y: y(appIcon.y - head)))
  arrow.line(to: NSPoint(x: arrowTo, y: y(appIcon.y)))
  arrow.line(to: NSPoint(x: arrowTo - head, y: y(appIcon.y + head)))
  arrow.lineWidth = 2.5
  arrow.lineCapStyle = .round
  arrow.lineJoinStyle = .round
  arrowColour.setStroke()
  arrow.stroke()

  // Hint under the icon labels.
  let hint = NSAttributedString(
    string: "Drag omnirush.ai to Applications to install",
    attributes: [
      .font: NSFont.systemFont(ofSize: 12.5, weight: .regular),
      .foregroundColor: muted,
    ])
  hint.draw(at: NSPoint(x: (width - hint.size().width) / 2, y: y(352) - hint.size().height / 2))

  NSGraphicsContext.restoreGraphicsState()
  // 72 dpi at 1x and 144 dpi at @2x, so tiffutil -cathidpicheck pairs them.
  rep.size = NSSize(width: width, height: height)
  guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("png") }
  return png
}

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
for (scale, name) in [(CGFloat(1), "dmg-background.png"), (CGFloat(2), "dmg-background@2x.png")] {
  let url = outputDir.appendingPathComponent(name)
  try render(scale: scale).write(to: url)
  print("wrote \(url.path)")
}

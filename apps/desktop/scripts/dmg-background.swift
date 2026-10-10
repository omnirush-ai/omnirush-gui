// Renders the macOS installer window background at 1x and @2x:
//
//   swift apps/desktop/scripts/dmg-background.swift [output-dir] [variant]
//
// Run it on a Mac (the type is SF Pro, the app's UI font) and commit the two
// PNGs it writes to apps/desktop/build/. The layout must match `dmg` in
// apps/desktop/electron-builder.yml: a 660x400 window, the app icon centred
// at (170, 190) and the Applications link at (490, 190). Finder draws the icon
// labels black on a picture background in Light and Dark Mode alike, so the
// band behind them (y 255-285) stays light in every variant. The art is
// deterministic: the grain comes from a fixed-seed generator.
import AppKit

let width: CGFloat = 660
let height: CGFloat = 400
let appIcon = CGPoint(x: 170, y: 190)
let applicationsIcon = CGPoint(x: 490, y: 190)

func rgb(_ value: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255, alpha: alpha)
}

// Brand palette (apps/app/src/app/index.css and the logo).
let navy: UInt32 = 0x011627
let navyLift: UInt32 = 0x0a2540
let blue: UInt32 = 0x0090ff
let cyan: UInt32 = 0x00a2c7
let ink: UInt32 = 0x1c2024
let muted: UInt32 = 0x60646c
let paper: UInt32 = 0xfcfcfd

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let desktopDir = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let outputDir =
  CommandLine.arguments.count > 1
  ? URL(fileURLWithPath: CommandLine.arguments[1]) : desktopDir.appendingPathComponent("build")
let variant = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "flow"
let markURL = desktopDir.appendingPathComponent("../app/public/omnirush-mark.png").standardizedFileURL
guard let markImage = NSImage(contentsOf: markURL),
  let mark = markImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fatalError("missing \(markURL.path)") }

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
  CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: stops.map { $0.1 } as CFArray,
    locations: stops.map { $0.0 })!
}

func glow(_ c: CGContext, _ centre: CGPoint, _ radius: CGFloat, _ colour: UInt32, _ alpha: CGFloat) {
  c.drawRadialGradient(
    gradient([(0, rgb(colour, alpha)), (1, rgb(colour, 0))]), startCenter: centre, startRadius: 0,
    endCenter: centre, endRadius: radius, options: [])
}

// The mark PNG is black on transparent; as a clip mask the dark pixels must be
// opaque, so build an inverted luminance mask once.
let markMask: CGImage = {
  let w = mark.width, h = mark.height
  let space = CGColorSpaceCreateDeviceGray()
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: space, bitmapInfo: 0)!
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.draw(mark, in: CGRect(x: 0, y: 0, width: w, height: h))
  // black mark on white -> mask where white shows through; invert so the mark is opaque.
  let data = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h)
  for i in 0..<(w * h) { data[i] = 255 - data[i] }
  return ctx.makeImage()!
}()

func drawMarkShape(_ c: CGContext, _ rect: CGRect, _ colour: CGColor, _ alpha: CGFloat = 1) {
  c.saveGState()
  c.setAlpha(alpha)
  c.translateBy(x: rect.minX, y: rect.maxY)
  c.scaleBy(x: 1, y: -1)
  let local = CGRect(origin: .zero, size: rect.size)
  // Masks: white = paint. The inverted image is white where the mark is.
  let maskForClip = CGImage(
    maskWidth: markMask.width, height: markMask.height, bitsPerComponent: 8, bitsPerPixel: 8,
    bytesPerRow: markMask.bytesPerRow, provider: markMask.dataProvider!, decode: [1, 0],
    shouldInterpolate: true)!
  c.clip(to: local, mask: maskForClip)
  c.setFillColor(colour)
  c.fill(local)
  c.restoreGState()
}

func text(_ c: CGContext, _ string: String, size: CGFloat, weight: NSFont.Weight, colour: CGColor, centreX: CGFloat? = nil, x: CGFloat = 0, midY: CGFloat, kern: CGFloat = 0) {
  let attributed = NSAttributedString(
    string: string,
    attributes: [
      .font: NSFont.systemFont(ofSize: size, weight: weight),
      .foregroundColor: NSColor(cgColor: colour)!, .kern: kern,
    ])
  let line = CTLineCreateWithAttributedString(attributed)
  let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
  c.saveGState()
  c.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  let originX = centreX.map { $0 - bounds.width / 2 } ?? x
  c.textPosition = CGPoint(x: originX, y: midY + (bounds.height / 2 + bounds.minY) - bounds.height * 0.08)
  CTLineDraw(line, c)
  c.restoreGState()
}

// Header: the mark beside the name, as on the app's welcome card.
func header(_ c: CGContext, colour: CGColor, y: CGFloat = 52) {
  let name = "omnirush"
  let font = NSFont.systemFont(ofSize: 16, weight: .semibold)
  let nameWidth = (name as NSString).size(withAttributes: [.font: font, .kern: -0.2]).width
  let markSize: CGFloat = 22
  let gap: CGFloat = 8
  let left = (width - (markSize + gap + nameWidth)) / 2
  drawMarkShape(c, CGRect(x: left, y: y - markSize / 2, width: markSize, height: markSize), colour)
  text(c, name, size: 16, weight: .semibold, colour: colour, x: left + markSize + gap, midY: y, kern: -0.2)
}

func hint(_ c: CGContext, colour: CGColor) {
  text(c, "Drag omnirush to Applications to install", size: 12.5, weight: .regular, colour: colour, centreX: width / 2, midY: 352)
}

// Film grain from a fixed-seed generator, so renders are repeatable.
func grain(_ c: CGContext, scale: CGFloat, amount: CGFloat) {
  let w = Int(width * scale), h = Int(height * scale)
  var seed: UInt64 = 0x6f6d6e6972757368
  var pixels = [UInt8](repeating: 0, count: w * h * 4)
  for i in 0..<(w * h) {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    let v = UInt8(truncatingIfNeeded: seed >> 56)
    let a = UInt8(CGFloat(abs(Int(v) - 128)) / 128 * amount * 255)
    let tone: UInt8 = v > 128 ? 255 : 0
    // premultiplied
    let p = UInt8((Int(tone) * Int(a)) / 255)
    pixels[i * 4] = p; pixels[i * 4 + 1] = p; pixels[i * 4 + 2] = p; pixels[i * 4 + 3] = a
  }
  let provider = CGDataProvider(data: Data(pixels) as CFData)!
  let image = CGImage(
    width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
  c.saveGState()
  c.translateBy(x: 0, y: height)
  c.scaleBy(x: 1, y: -1)
  c.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  c.restoreGState()
}

// A tapered ribbon that sweeps from behind the app icon and ends in an arrowhead
// pointing at Applications.
func ribbonArrow(from start: CGPoint, apex: CGPoint, tip: CGPoint, tail: CGFloat, neck: CGFloat, head: CGFloat, headLength: CGFloat) -> CGPath {
  // Quadratic centre line start -> tip with control `apex`, sampled.
  func point(_ t: CGFloat) -> CGPoint {
    let u = 1 - t
    return CGPoint(
      x: u * u * start.x + 2 * u * t * apex.x + t * t * tip.x,
      y: u * u * start.y + 2 * u * t * apex.y + t * t * tip.y)
  }
  func tangent(_ t: CGFloat) -> CGPoint {
    let d = CGPoint(
      x: 2 * (1 - t) * (apex.x - start.x) + 2 * t * (tip.x - apex.x),
      y: 2 * (1 - t) * (apex.y - start.y) + 2 * t * (tip.y - apex.y))
    let l = max(hypot(d.x, d.y), 0.001)
    return CGPoint(x: d.x / l, y: d.y / l)
  }
  // Find t where the head begins (headLength before the tip along the curve).
  var neckT: CGFloat = 1
  var travelled: CGFloat = 0
  var prev = tip
  var t: CGFloat = 1
  while t > 0 {
    t -= 0.002
    let p = point(t)
    travelled += hypot(p.x - prev.x, p.y - prev.y)
    prev = p
    if travelled >= headLength { neckT = t; break }
  }
  var left: [CGPoint] = []
  var right: [CGPoint] = []
  let steps = 80
  for i in 0...steps {
    let s = neckT * CGFloat(i) / CGFloat(steps)
    let p = point(s)
    let n = tangent(s)
    let normal = CGPoint(x: -n.y, y: n.x)
    let f = s / neckT
    // Ease the width from the tail to the neck.
    let w = (tail + (neck - tail) * (f * f * (3 - 2 * f))) / 2
    left.append(CGPoint(x: p.x + normal.x * w, y: p.y + normal.y * w))
    right.append(CGPoint(x: p.x - normal.x * w, y: p.y - normal.y * w))
  }
  let neckPoint = point(neckT)
  let n = tangent(neckT)
  let normal = CGPoint(x: -n.y, y: n.x)
  let path = CGMutablePath()
  path.move(to: left[0])
  for p in left.dropFirst() { path.addLine(to: p) }
  path.addLine(to: CGPoint(x: neckPoint.x + normal.x * head / 2, y: neckPoint.y + normal.y * head / 2))
  path.addLine(to: tip)
  path.addLine(to: CGPoint(x: neckPoint.x - normal.x * head / 2, y: neckPoint.y - normal.y * head / 2))
  for p in right.reversed() { path.addLine(to: p) }
  // Round tail.
  path.addArc(center: point(0), radius: tail / 2, startAngle: atan2(right[0].y - point(0).y, right[0].x - point(0).x), endAngle: atan2(left[0].y - point(0).y, left[0].x - point(0).x), clockwise: false)
  path.closeSubpath()
  return path
}

func fillLinear(_ c: CGContext, _ path: CGPath, _ stops: [(CGFloat, CGColor)], from: CGPoint, to: CGPoint) {
  c.saveGState()
  c.addPath(path)
  c.clip()
  c.drawLinearGradient(gradient(stops), start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  c.restoreGState()
}

// Keeps the label band calm: a soft light wash behind both labels.
func labelWash(_ c: CGContext, _ colour: UInt32, _ alpha: CGFloat) {
  for icon in [appIcon, applicationsIcon] {
    c.saveGState()
    c.translateBy(x: icon.x, y: 270)
    c.scaleBy(x: 1, y: 0.28)
    glow(c, .zero, 120, colour, alpha)
    c.restoreGState()
  }
}

// Variant "flow": light paper, brand colour fields, a broad gradient ribbon
// arrow sweeping over the gap.
func flow(_ c: CGContext, scale: CGFloat) {
  c.setFillColor(rgb(paper)); c.fill(CGRect(x: 0, y: 0, width: width, height: height))
  glow(c, CGPoint(x: 600, y: 20), 330, blue, 0.20)
  glow(c, CGPoint(x: 40, y: 400), 300, cyan, 0.16)
  glow(c, CGPoint(x: 330, y: 150), 220, navyLift, 0.07)
  // A fainter echo below the main ribbon gives the sweep some motion.
  let echo = ribbonArrow(
    from: CGPoint(x: 200, y: 236), apex: CGPoint(x: 322, y: 150), tip: CGPoint(x: 398, y: 214),
    tail: 6, neck: 14, head: 0.1, headLength: 1)
  c.addPath(echo); c.setFillColor(rgb(cyan, 0.22)); c.fillPath()
  let arrow = ribbonArrow(
    from: CGPoint(x: 214, y: 206), apex: CGPoint(x: 322, y: 84), tip: CGPoint(x: 414, y: 180),
    tail: 16, neck: 30, head: 66, headLength: 44)
  c.saveGState()
  c.setShadow(offset: CGSize(width: 0, height: 10), blur: 34, color: rgb(blue, 0.35))
  c.addPath(arrow); c.setFillColor(rgb(navy)); c.fillPath()
  c.restoreGState()
  fillLinear(c, arrow, [(0, rgb(navy)), (0.55, rgb(blue)), (1, rgb(cyan))], from: CGPoint(x: 214, y: 206), to: CGPoint(x: 414, y: 180))
  // A highlight along the ribbon's upper edge for depth.
  c.saveGState()
  c.addPath(arrow); c.clip()
  c.drawLinearGradient(gradient([(0, rgb(0xffffff, 0.28)), (0.45, rgb(0xffffff, 0))]), start: CGPoint(x: 0, y: 84), end: CGPoint(x: 0, y: 200), options: [])
  c.restoreGState()
  labelWash(c, paper, 0.9)
  grain(c, scale: scale, amount: 0.05)
  header(c, colour: rgb(ink))
  hint(c, colour: rgb(muted))
}

// Variant "midnight": deep brand navy with a light mesh and motion streaks
// that converge into a chevron, and a frosted shelf behind the labels.
func midnight(_ c: CGContext, scale: CGFloat) {
  c.drawLinearGradient(gradient([(0, rgb(navyLift)), (1, rgb(navy))]), start: .zero, end: CGPoint(x: 0, y: height), options: [])
  glow(c, CGPoint(x: 520, y: 120), 300, blue, 0.40)
  glow(c, CGPoint(x: 120, y: 320), 260, cyan, 0.22)
  glow(c, CGPoint(x: 330, y: 0), 260, 0x6e56cf, 0.18)
  // Motion streaks: thin lines that speed up toward Applications.
  c.saveGState()
  c.setLineCap(.round)
  for i in 0..<15 {
    let f = CGFloat(i) / 14
    let y = 120 + f * 140
    let bend = (f - 0.5) * 60
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 120 + abs(f - 0.5) * 60, y: y))
    path.addQuadCurve(to: CGPoint(x: 392 - abs(f - 0.5) * 90, y: 190 + (y - 190) * 0.25), control: CGPoint(x: 300, y: y - bend * 0.3))
    c.addPath(path)
    c.setLineWidth(1.2)
    c.setStrokeColor(rgb(0xffffff, 0.10 + 0.25 * (1 - abs(f - 0.5) * 2)))
    c.strokePath()
  }
  c.restoreGState()
  // The chevron the streaks resolve into.
  let chevron = CGMutablePath()
  chevron.move(to: CGPoint(x: 384, y: 166))
  chevron.addLine(to: CGPoint(x: 408, y: 190))
  chevron.addLine(to: CGPoint(x: 384, y: 214))
  c.saveGState()
  c.setShadow(offset: .zero, blur: 18, color: rgb(cyan, 0.9))
  c.addPath(chevron); c.setLineWidth(5); c.setLineCap(.round); c.setLineJoin(.round)
  c.setStrokeColor(rgb(0xffffff)); c.strokePath()
  c.restoreGState()
  // Frosted pills behind the labels.
  for icon in [appIcon, applicationsIcon] {
    let pill = CGPath(roundedRect: CGRect(x: icon.x - 64, y: 258, width: 128, height: 26), cornerWidth: 13, cornerHeight: 13, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: 4), blur: 14, color: rgb(0x000000, 0.35))
    c.addPath(pill); c.setFillColor(rgb(0xffffff, 0.9)); c.fillPath()
    c.restoreGState()
  }
  grain(c, scale: scale, amount: 0.06)
  header(c, colour: rgb(0xffffff))
  hint(c, colour: rgb(0xffffff, 0.72))
}

// Variant "orbit": pale paper, the mark echoed as a huge faint watermark, and a
// comet trail of dots that grows from the app toward Applications.
func orbit(_ c: CGContext, scale: CGFloat) {
  c.drawLinearGradient(gradient([(0, rgb(paper)), (1, rgb(0xeef1f6))]), start: .zero, end: CGPoint(x: 0, y: height), options: [])
  glow(c, CGPoint(x: 490, y: 190), 210, blue, 0.16)
  glow(c, CGPoint(x: 170, y: 190), 170, cyan, 0.10)
  drawMarkShape(c, CGRect(x: 190, y: -40, width: 480, height: 480), rgb(navy), 0.045)
  // Comet trail along an arc above the centre line.
  let start = CGPoint(x: 246, y: 190), control = CGPoint(x: 326, y: 112), end = CGPoint(x: 400, y: 184)
  let count = 22
  for i in 0..<count {
    let t = CGFloat(i) / CGFloat(count - 1)
    let u = 1 - t
    let p = CGPoint(x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y)
    let r = 1.2 + t * t * 5.5
    let colour = t < 0.5 ? cyan : blue
    c.setFillColor(rgb(colour, 0.25 + 0.75 * t))
    c.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
  }
  c.saveGState()
  c.setShadow(offset: .zero, blur: 16, color: rgb(blue, 0.8))
  let head = CGMutablePath()
  head.move(to: CGPoint(x: 398, y: 170)); head.addLine(to: CGPoint(x: 414, y: 186)); head.addLine(to: CGPoint(x: 394, y: 198))
  c.addPath(head); c.setLineWidth(4); c.setLineCap(.round); c.setLineJoin(.round); c.setStrokeColor(rgb(blue)); c.strokePath()
  c.restoreGState()
  labelWash(c, paper, 0.8)
  grain(c, scale: scale, amount: 0.04)
  header(c, colour: rgb(ink))
  hint(c, colour: rgb(muted))
}

func render(scale: CGFloat) -> Data {
  let w = Int(width * scale), h = Int(height * scale)
  guard
    let c = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fatalError("context") }
  // Top-left origin in points.
  c.translateBy(x: 0, y: CGFloat(h))
  c.scaleBy(x: scale, y: -scale)
  c.interpolationQuality = .high
  let graphics = NSGraphicsContext(cgContext: c, flipped: true)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = graphics
  switch variant {
  case "flow": flow(c, scale: scale)
  case "midnight": midnight(c, scale: scale)
  case "orbit": orbit(c, scale: scale)
  default: fatalError("unknown variant \(variant)")
  }
  NSGraphicsContext.restoreGraphicsState()
  let rep = NSBitmapImageRep(cgImage: c.makeImage()!)
  // 72 dpi at 1x and 144 dpi at @2x, so tiffutil -cathidpicheck pairs them.
  rep.size = NSSize(width: width, height: height)
  return rep.representation(using: .png, properties: [:])!
}

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
for (scale, name) in [(CGFloat(1), "dmg-background.png"), (CGFloat(2), "dmg-background@2x.png")] {
  let url = outputDir.appendingPathComponent(name)
  try render(scale: scale).write(to: url)
  print("wrote \(url.path)")
}

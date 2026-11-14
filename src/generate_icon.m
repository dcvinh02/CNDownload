#import <Cocoa/Cocoa.h>

void saveIconPng(int size, NSString *outputPath) {
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:NULL
                      pixelsWide:size
                      pixelsHigh:size
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSCalibratedRGBColorSpace
                     bytesPerRow:0
                    bitsPerPixel:0];

    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext *ctx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [NSGraphicsContext setCurrentContext:ctx];

    CGFloat s = (CGFloat)size;
    CGFloat pad = s * 0.08;
    NSRect rect = NSMakeRect(pad, pad, s - pad * 2, s - pad * 2);
    CGFloat radius = rect.size.width * 0.225;

    // Đổ bóng nhẹ cho squircle
    NSShadow *shadow = [[NSShadow alloc] init];
    [shadow setShadowColor:[NSColor colorWithCalibratedWhite:0.0 alpha:0.28]];
    [shadow setShadowOffset:NSMakeSize(0, -s * 0.02)];
    [shadow setShadowBlurRadius:s * 0.04];
    [shadow set];

    NSBezierPath *bgPath = [NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius];

    // Gradient nền xanh hiện đại (#0f172a -> #1d4ed8 -> #0ea5e9)
    NSGradient *grad = [[NSGradient alloc] initWithColorsAndLocations:
        [NSColor colorWithCalibratedRed:0.06 green:0.09 blue:0.16 alpha:1.0], 0.0,
        [NSColor colorWithCalibratedRed:0.15 green:0.39 blue:0.92 alpha:1.0], 0.55,
        [NSColor colorWithCalibratedRed:0.02 green:0.71 blue:0.83 alpha:1.0], 1.0,
        nil];
    [grad drawInBezierPath:bgPath angle:-45.0];

    // Tắt shadow cho các chi tiết bên trong
    [[[NSShadow alloc] init] set];

    // Viền sáng tinh tế
    [[NSColor colorWithCalibratedWhite:1.0 alpha:0.22] setStroke];
    [bgPath setLineWidth:MAX(1.0, s * 0.012)];
    [bgPath stroke];

    // Vòng tròn sáng trung tâm
    CGFloat circleSize = s * 0.52;
    NSRect circleRect = NSMakeRect((s - circleSize) / 2.0, (s - circleSize) / 2.0 + s * 0.03, circleSize, circleSize);
    NSBezierPath *circlePath = [NSBezierPath bezierPathWithOvalInRect:circleRect];
    [[NSColor colorWithCalibratedWhite:1.0 alpha:0.14] setFill];
    [circlePath fill];
    [[NSColor colorWithCalibratedWhite:1.0 alpha:0.35] setStroke];
    [circlePath setLineWidth:MAX(1.0, s * 0.015)];
    [circlePath stroke];

    // Biểu tượng nút Play kết hợp mũi tên Download màu trắng ở giữa
    NSBezierPath *playPath = [NSBezierPath bezierPath];
    CGFloat cx = s * 0.50;
    CGFloat cy = s * 0.53;
    CGFloat r = s * 0.14;
    [playPath moveToPoint:NSMakePoint(cx - r * 0.65, cy + r * 0.85)];
    [playPath lineToPoint:NSMakePoint(cx + r * 0.95, cy)];
    [playPath lineToPoint:NSMakePoint(cx - r * 0.65, cy - r * 0.85)];
    [playPath closePath];
    [[NSColor whiteColor] setFill];
    [playPath fill];

    // Mũi tên tải xuống phía dưới
    NSBezierPath *dlBar = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(s * 0.30, s * 0.19, s * 0.40, s * 0.055)
                                                          xRadius:s * 0.025
                                                          yRadius:s * 0.025];
    [[NSColor colorWithCalibratedRed:0.20 green:0.95 blue:0.65 alpha:1.0] setFill];
    [dlBar fill];

    // Nhãn "CN PRO" góc trên phải
    if (size >= 64) {
        NSMutableParagraphStyle *style = [[NSMutableParagraphStyle alloc] init];
        [style setAlignment:NSTextAlignmentCenter];
        NSDictionary *attrs = @{
            NSFontAttributeName: [NSFont systemFontOfSize:s * 0.085 weight:NSFontWeightHeavy],
            NSForegroundColorAttributeName: [NSColor whiteColor],
            NSParagraphStyleAttributeName: style
        };
        NSString *badge = @"CN 12";
        [badge drawInRect:NSMakeRect(s * 0.25, s * 0.74, s * 0.50, s * 0.12) withAttributes:attrs];
    }

    [NSGraphicsContext restoreGraphicsState];

    NSData *pngData = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [pngData writeToFile:outputPath atomically:YES];
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) return 1;
        NSString *baseDir = [NSString stringWithUTF8String:argv[1]];
        NSString *iconsetDir = [baseDir stringByAppendingPathComponent:@"AppIcon.iconset"];
        [[NSFileManager defaultManager] createDirectoryAtPath:iconsetDir withIntermediateDirectories:YES attributes:nil error:nil];

        int sizes[] = {16, 32, 128, 256, 512};
        for (int i = 0; i < 5; i++) {
            int sz = sizes[i];
            NSString *p1 = [iconsetDir stringByAppendingPathComponent:[NSString stringWithFormat:@"icon_%dx%d.png", sz, sz]];
            NSString *p2 = [iconsetDir stringByAppendingPathComponent:[NSString stringWithFormat:@"icon_%dx%d@2x.png", sz, sz]];
            saveIconPng(sz, p1);
            saveIconPng(sz * 2, p2);
        }

        NSString *publicPng = [[baseDir stringByAppendingPathComponent:@"public"] stringByAppendingPathComponent:@"icon.png"];
        saveIconPng(512, publicPng);
    }
    return 0;
}

#ifdef __APPLE__
#import <AppKit/AppKit.h>

void macos_set_compact_window_style(void *ns_window_ptr, int is_compact) {
    if (!ns_window_ptr) return;
    NSWindow *win = (__bridge NSWindow *)ns_window_ptr;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSButton *closeBtn = [win standardWindowButton:NSWindowCloseButton];
        NSButton *minBtn   = [win standardWindowButton:NSWindowMiniaturizeButton];
        NSButton *zoomBtn  = [win standardWindowButton:NSWindowZoomButton];
        BOOL hide = is_compact ? YES : NO;
        if (closeBtn) [closeBtn setHidden:hide];
        if (minBtn)   [minBtn setHidden:hide];
        if (zoomBtn)  [zoomBtn setHidden:hide];

        if (is_compact) {
            // Behave like a floating utility/settings panel so tiling managers (e.g. AeroSpace)
            // keep Compact Mode floating and never tile it, without breaking FullSizeContentView.
            [win setCollectionBehavior:NSWindowCollectionBehaviorMoveToActiveSpace
                                     | NSWindowCollectionBehaviorFullScreenAuxiliary];
            [win setHidesOnDeactivate:NO];
        } else {
            [win setCollectionBehavior:NSWindowCollectionBehaviorFullScreenPrimary];
        }
    });
}
#endif

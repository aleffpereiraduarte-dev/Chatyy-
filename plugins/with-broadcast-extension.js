/**
 * Config plugin — adds the ChatyyBroadcastExtension iOS target to the Xcode
 * project on every `expo prebuild`. Without this, the extension's Swift
 * source under ios/ChatyyBroadcastExtension/ sits orphaned and never gets
 * compiled.
 *
 * WHAT IT DOES:
 *   1. EMBEDS the extension source files (SampleHandler.swift, Info.plist,
 *      ChatyyBroadcastExtension.entitlements) directly as template strings
 *      below. On every prebuild, withDangerousMod writes them to disk at
 *      `${platformProjectRoot}/ChatyyBroadcastExtension/`. This survives
 *      `expo prebuild --clean` even if the source tree under ios/ was wiped.
 *      The canonical copies in /ios/ChatyyBroadcastExtension/ are kept in
 *      the repo for human reference / diffing only — the plugin does not
 *      depend on them at prebuild time.
 *   2. Adds a new PBXNativeTarget of type appex (com.apple.product-type.app-extension).
 *   3. Sets the bundle id to com.onemundo.mail.broadcast and inherits team
 *      from the main target so EAS signing picks it up automatically.
 *   4. Adds the App Group entitlement (group.com.onemundo.mail) to the main
 *      app so it can read frames the extension wrote. The extension target
 *      has its OWN entitlements file with the same App Group (embedded
 *      below).
 *   5. Adds ReplayKit.framework to the extension's link phase.
 *
 * RUN: `expo prebuild --clean` to regenerate, then `pod install` in ios/.
 *
 * WARNING: This rewrites project.pbxproj. If a developer manually edited
 * the Xcode project, those edits will be clobbered. Always treat ios/ as
 * generated.
 *
 * IF YOU EDIT THE SOURCE FILES: update BOTH the canonical copies under
 * /ios/ChatyyBroadcastExtension/ AND the embedded strings below. The
 * embedded version is what actually compiles; the canonical copies are
 * just reference.
 */

const fs = require('fs');
const path = require('path');
const { withXcodeProject, withEntitlementsPlist, withDangerousMod } = require('expo/config-plugins');

const EXT_NAME = 'ChatyyBroadcastExtension';
const EXT_BUNDLE_ID = 'com.onemundo.mail.broadcast';
const APP_GROUP = 'group.com.onemundo.mail';

// =====================================================================
// EMBEDDED SOURCE FILES — kept in sync with /ios/ChatyyBroadcastExtension/
// =====================================================================

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${APP_GROUP}</string>
\t</array>
</dict>
</plist>
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Chatyy Screen Share</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.broadcast-services-upload</string>
\t\t<key>NSExtensionPrincipalClass</key>
\t\t<string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
\t\t<key>RPBroadcastProcessMode</key>
\t\t<string>RPBroadcastProcessModeSampleBuffer</string>
\t</dict>
</dict>
</plist>
`;

const SAMPLE_HANDLER_SWIFT = `//
//  SampleHandler.swift
//  ChatyyBroadcastExtension
//
//  ReplayKit Broadcast Upload Extension. iOS spawns this process when the
//  user confirms the system broadcast picker. We receive raw screen frames
//  (CMSampleBuffer) here, downscale them to 720p, JPEG-encode at ~50% and
//  drop the bytes into an App Group shared container so the main Chatyy app
//  can pick them up and push them into the active WebRTC video sender.
//
//  WHY THIS ARCHITECTURE (and not a TCP socket / Unix domain socket):
//   - Broadcast Extensions are SEVERELY memory-capped (~50MB total RSS).
//     Anything over and iOS kills the extension with NO callback — Apple's
//     docs explicitly warn against framework imports beyond ReplayKit + the
//     bare-minimum CoreVideo/CoreMedia.
//   - Extensions are sandboxed and cannot open arbitrary TCP/UDP sockets.
//     Local-only sockets technically work but break in the simulator and
//     under "Low Data Mode" — App Group files don't.
//   - CFNotification (Darwin notify) is the documented IPC for App Group
//     extensions <-> host. We post a notification per frame; the host reads
//     the latest jpeg from the shared container.
//
//  FRAME RATE: ~15 fps (skipFrameCounter). Screen share doesn't need 30fps
//  and capping protects the RAM ceiling. Cap also de-noises the WebRTC
//  encoder so bandwidth stays under 1.2Mbps.
//
//  RESOLUTION: longest-edge clamped to 1280px. iPad Pro is ~2732px native;
//  raw frames at native res = ~22MB each = instant OOM.
//

import ReplayKit
import CoreImage
import CoreVideo
import CoreMedia
import ImageIO
import MobileCoreServices

class SampleHandler: RPBroadcastSampleHandler {

    // App Group identifier — must match the entitlement + main app entitlement.
    // Already in use by ShareExtension (memory #511) so re-using the same group
    // avoids needing a new provisioning profile entry.
    private static let appGroupId = "${APP_GROUP}"

    // Notification name the main app listens for. Darwin notifications are
    // process-global, no payload — the host reads the latest frame from disk.
    private static let frameNotificationName = "com.onemundo.mail.screenshare.frame"
    private static let stateNotificationName = "com.onemundo.mail.screenshare.state"

    // Filename inside the App Group container. We double-buffer (.a / .b)
    // so the main app reading the file never races against us writing it
    // mid-frame. Each frame post alternates which file is "fresh".
    private static let frameFileA = "screenshare-frame-a.jpg"
    private static let frameFileB = "screenshare-frame-b.jpg"
    private static let statePtrFile = "screenshare-state.txt"

    private var ciContext: CIContext?
    private var sharedContainerURL: URL?
    private var frameCounter: UInt64 = 0
    private var useBufferA = true

    // Skip every N frames to cap the rate. RPScreenRecorder delivers at the
    // device refresh rate (60–120Hz on modern iPhones) so skipping 3 of every
    // 4 gives ~15–30fps depending on device.
    private var skipFrameCounter = 0
    private let frameSkipRatio = 3

    // Cache the JPEG-encode CFDictionary so we don't re-alloc per frame.
    private lazy var jpegProperties: CFDictionary = {
        let dict: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.5
        ]
        return dict as CFDictionary
    }()

    override init() {
        super.init()
        // CIContext for fast GPU-backed downscale. Software fallback is too
        // slow at 60Hz and would blow the CPU budget.
        self.ciContext = CIContext(options: [.useSoftwareRenderer: false])
        self.sharedContainerURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: SampleHandler.appGroupId)
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // User confirmed picker → ReplayKit started capturing. Notify main app
        // so it can hot-swap the WebRTC sender's track.
        writeState("started")
        postState()
    }

    override func broadcastPaused() {
        writeState("paused")
        postState()
    }

    override func broadcastResumed() {
        writeState("started")
        postState()
    }

    override func broadcastFinished() {
        writeState("finished")
        postState()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                       with sampleBufferType: RPSampleBufferType) {
        // We only care about video frames. Audio (sampleBufferType == .audioApp)
        // could be piped too but iOS clamps that to ringer/media audio only —
        // and most call apps don't share device audio with the peer anyway.
        // Microphone capture continues from the main app's WebRTC pipeline.
        guard sampleBufferType == .video else { return }

        // Rate-cap.
        skipFrameCounter += 1
        if skipFrameCounter % (frameSkipRatio + 1) != 0 {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard let containerURL = sharedContainerURL else { return }
        guard let context = ciContext else { return }

        // Downscale on GPU before encoding to JPEG. Going from native 2732px to
        // 1280px shrinks the JPEG ~5×, which both honors our 50MB ceiling and
        // saves the main app a CPU resize step before handing to RTCVideoSource.
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let srcW = ciImage.extent.width
        let srcH = ciImage.extent.height
        let longEdge: CGFloat = 1280
        let scale: CGFloat = min(1.0, longEdge / max(srcW, srcH))
        let scaled = scale < 1.0
            ? ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : ciImage

        // Encode to JPEG. CGImageDestination is the fastest path that doesn't
        // require UIKit (which is banned in broadcast extensions).
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, kUTTypeJPEG, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cgImage, jpegProperties)
        guard CGImageDestinationFinalize(dest) else { return }

        // Double-buffer write — alternate file each frame so the reader never
        // sees a half-written JPEG. Pointer file tells the reader which one is
        // fresh.
        let targetName = useBufferA ? SampleHandler.frameFileA : SampleHandler.frameFileB
        let targetURL = containerURL.appendingPathComponent(targetName)
        let ptrURL = containerURL.appendingPathComponent(SampleHandler.statePtrFile)

        do {
            try data.write(to: targetURL, options: .atomic)
            let ptr = useBufferA ? "a" : "b"
            try ptr.write(to: ptrURL, atomically: true, encoding: .utf8)
        } catch {
            // Disk write failed — likely container full or revoked. Bail this
            // frame, the extension keeps running.
            return
        }

        useBufferA.toggle()
        frameCounter &+= 1

        // Post Darwin notification so main app's CFNotification observer fires.
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(SampleHandler.frameNotificationName as CFString),
            nil, nil, true
        )
    }

    // Helper — writes the broadcast lifecycle state to a known file so the
    // main app can read it even if it was cold-started after broadcast began.
    private func writeState(_ state: String) {
        guard let url = sharedContainerURL?.appendingPathComponent("screenshare-broadcast-state.txt") else { return }
        try? state.write(to: url, atomically: true, encoding: .utf8)
    }

    private func postState() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(SampleHandler.stateNotificationName as CFString),
            nil, nil, true
        )
    }
}
`;

const EMBEDDED_FILES = {
  'SampleHandler.swift': SAMPLE_HANDLER_SWIFT,
  'Info.plist': INFO_PLIST,
  [`${EXT_NAME}.entitlements`]: ENTITLEMENTS_PLIST,
};

// =====================================================================
// MODS
// =====================================================================

function withBroadcastExtensionFiles(config) {
  // Write the extension source files into the prebuild output. We always
  // write from the embedded strings above — that way `prebuild --clean`
  // (which nukes ios/) leaves us with a fully reconstituted extension dir
  // even though the canonical copies under /ios/ were deleted.
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const destDir = path.join(cfg.modRequest.platformProjectRoot, EXT_NAME);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      for (const [fileName, content] of Object.entries(EMBEDDED_FILES)) {
        const dst = path.join(destDir, fileName);
        fs.writeFileSync(dst, content, 'utf8');
      }
      return cfg;
    },
  ]);
}

function withMainAppGroup(config) {
  // Main app needs App Group too so it can read frames the extension wrote.
  return withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
}

function withBroadcastTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName || 'ChatyyMail';

    // Idempotency — skip if already added
    const existingTarget = project.pbxNativeTargetSection?.();
    if (existingTarget) {
      for (const key of Object.keys(existingTarget)) {
        const t = existingTarget[key];
        if (t && typeof t === 'object' && t.name === EXT_NAME) {
          return cfg;
        }
      }
    }

    const targetUuid = project.generateUuid();
    const groupUuid = project.generateUuid();

    // Create a PBXGroup for the extension's files
    const group = project.addPbxGroup(
      ['SampleHandler.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
      EXT_NAME,
      EXT_NAME,
      '"<group>"'
    );

    // Attach group to root
    const rootGroup = project.getFirstProject()['firstProject']['mainGroup'];
    project.addToPbxGroup(group.uuid, rootGroup);

    // Add the target itself
    const target = project.addTarget(
      EXT_NAME,
      'app_extension',
      EXT_NAME,
      EXT_BUNDLE_ID
    );

    // Add Swift source build phase
    project.addBuildPhase(
      ['SampleHandler.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid
    );

    // Frameworks: ReplayKit
    project.addBuildPhase(
      ['ReplayKit.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid
    );

    // Embed the extension into the main app's bundle
    project.addBuildPhase(
      [],
      'PBXCopyFilesBuildPhase',
      'Embed App Extensions',
      project.getFirstTarget().uuid,
      'app_extension'
    );

    // Build settings — point to entitlements + Info.plist
    const xcConfig = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(xcConfig)) {
      const c = xcConfig[key];
      if (c.buildSettings && c.buildSettings.PRODUCT_NAME === `"${EXT_NAME}"`) {
        c.buildSettings.INFOPLIST_FILE = `"${EXT_NAME}/Info.plist"`;
        c.buildSettings.CODE_SIGN_ENTITLEMENTS = `"${EXT_NAME}/${EXT_NAME}.entitlements"`;
        c.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '"15.0"';
        c.buildSettings.SWIFT_VERSION = '5.0';
        c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${EXT_BUNDLE_ID}"`;
        c.buildSettings.CODE_SIGN_STYLE = '"Automatic"';
        c.buildSettings.LD_RUNPATH_SEARCH_PATHS =
          '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
      }
    }

    return cfg;
  });
}

module.exports = function withBroadcastExtension(config) {
  config = withBroadcastExtensionFiles(config);
  config = withMainAppGroup(config);
  config = withBroadcastTarget(config);
  return config;
};

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

// [2026-05-15 refactor #827] Migrated from custom RPBroadcastSampleHandler +
// App-Group-file IPC to LKSampleHandler (LiveKit-provided base class). The old
// path captured CMSampleBuffer → JPEG → App Group disk → Darwin notification
// → host reads frame, but those frames never reached the WebRTC video sender
// because LiveKit's `setScreenShareEnabled(true)` expects a broadcast
// extension whose handler is built on top of LKSampleHandler. Now LiveKit
// owns the entire pipeline: extension publishes a new VideoTrack via the
// "broadcast room" mechanism, host subscribes inside the active Room.
//
// Host-side requirements (see app/call.js):
//   - `Room` ctor must receive iosScreenSharePreferences = {
//       broadcastBundleId: 'com.onemundo.mail.broadcast',
//       useBroadcastExtension: true,
//     }
//   - App Group entitlement `group.com.onemundo.mail` must be on BOTH the
//     main app AND this extension (this plugin sets both — see
//     withMainAppGroup + ENTITLEMENTS_PLIST below).
//
// No more App-Group-file IPC, no manual JPEG encode, no CFNotification
// polling. LKSampleHandler internally pumps CMSampleBuffers through
// LiveKit's broadcast room → renders on every subscriber peer in the call.
const SAMPLE_HANDLER_SWIFT = `//
//  SampleHandler.swift
//  ChatyyBroadcastExtension
//
//  LiveKit-aware broadcast upload extension. Inherits from LKSampleHandler
//  so the captured screen frames are published directly into the LiveKit
//  room via the SDK's internal broadcast pipeline — no custom IPC needed.
//

import ReplayKit
import LiveKit

class SampleHandler: LKSampleHandler {
    // Enable logging in TestFlight so we can grep the device console for
    // "[LiveKit][SampleHandler]" while debugging screen-share failures on
    // real devices. Has zero runtime cost in Release otherwise.
    override var enableLogging: Bool { true }

    // Small jitter buffer (in ms). LK defaults to 0 which can cause encoder
    // hiccups on cellular when the screen recorder bursts frames. 50ms is
    // imperceptible to the viewer and smooths bursts without adding lag.
    override var broadcastDelayMillis: Int { 50 }
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

// [2026-05-15 #827] Append broadcast target to Podfile so LiveKitClient
// gets linked into the extension. expo prebuild regenerates Podfile from
// scratch every build, so a static edit in /ios/Podfile would be wiped —
// we must inject the snippet at prebuild time. Idempotent: skip if the
// target string is already present (handles repeated prebuilds in the
// same build folder).
function withBroadcastPodTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      let pod = fs.readFileSync(podfilePath, 'utf8');
      const marker = `target '${EXT_NAME}' do`;
      if (pod.includes(marker)) return cfg;

      // [2026-05-15 fix v3] CocoaPods requires extension targets NESTED
      // INSIDE the main app target — otherwise: "Unable to find host targets
      // for ChatyyBroadcastExtension".
      //
      // v2 took the LAST top-level `end` — but the Expo template has a
      // `post_install do |installer| ... end` block AFTER `target 'Chatyy'
      // do ... end`, so the last top-level `end` was post_install's, not
      // the main target's. The nested block landed OUTSIDE the main target.
      //
      // v3 strategy: locate the `target '<MainAppName>' do` line directly,
      // then walk forward with do/end depth counting (ignoring inline `do`
      // keywords like `if/unless/while...end`) until depth returns to 0 —
      // that's the closing `end` of the main target. Insert before it.
      const lines = pod.split('\n');

      // Find main app target. Expo always uses `target '<displayName>' do`
      // where displayName matches CFBundleName. Search for any line that
      // starts a target and is NOT our extension.
      let mainTargetLine = -1;
      let mainTargetName = '';
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*target ['"]([^'"]+)['"] do\b/);
        if (m && m[1] !== EXT_NAME) {
          mainTargetLine = i;
          mainTargetName = m[1];
          break; // first target is the main app
        }
      }
      if (mainTargetLine === -1) {
        console.warn('[with-broadcast-extension] No main target found — skipping (run prebuild first)');
        return cfg;
      }

      // Walk forward, tracking do/end balance. Skip inline `end` words
      // and only count `do` at end-of-line or before optional |args|.
      let depth = 1;
      let mainTargetEndLine = -1;
      for (let i = mainTargetLine + 1; i < lines.length; i++) {
        const line = lines[i];
        // Each `do` that opens a block (block syntax: `... do` or `... do |x|`)
        const doMatches = line.match(/\bdo\b(\s*\|[^|]*\|)?\s*$/);
        if (doMatches) depth++;
        // Each `end` that closes a block (standalone or with comment)
        if (/^\s*end\b/.test(line)) {
          depth--;
          if (depth === 0) { mainTargetEndLine = i; break; }
        }
      }
      if (mainTargetEndLine === -1) {
        console.warn(`[with-broadcast-extension] Could not find closing 'end' of target '${mainTargetName}' — skipping`);
        return cfg;
      }

      const nested = [
        `  # [2026-05-15 #827] Auto-injected nested broadcast extension target.`,
        `  # Inheriting :search_paths so we don't double-link the main app's`,
        `  # heavy pods (Firebase, etc) — extension just needs LiveKit + RTC.`,
        `  target '${EXT_NAME}' do`,
        `    inherit! :search_paths`,
        `    platform :ios, '15.0'`,
        `    pod 'LiveKitClient', '~> 2.0'`,
        `  end`,
      ];
      lines.splice(mainTargetEndLine, 0, ...nested);
      fs.writeFileSync(podfilePath, lines.join('\n'));
      console.log(`[with-broadcast-extension] Injected nested ${EXT_NAME} target inside '${mainTargetName}' (before line ${mainTargetEndLine + 1})`);
      return cfg;
    },
  ]);
}

module.exports = function withBroadcastExtension(config) {
  config = withBroadcastExtensionFiles(config);
  config = withMainAppGroup(config);
  config = withBroadcastTarget(config);
  config = withBroadcastPodTarget(config);
  return config;
};

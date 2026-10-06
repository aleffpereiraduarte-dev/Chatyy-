/**
 * Config plugin — adds the ChatyyBroadcastExtension iOS target (ReplayKit
 * Broadcast Upload Extension) so "Compartilhar tela" on iOS captures the
 * WHOLE device screen (system picker) instead of only this app's window.
 *
 * [2026-10-06 screen-share iOS] Re-enabled + hardened. History:
 *   #827 (2026-05-15) created it; Wave 19 disabled it because the nested
 *   Podfile target used `inherit! :search_paths`, which de-duplicated the
 *   LiveKitClient pod already autolinked in the parent → the extension had
 *   no module map / no build dependency → "no such module 'LiveKit'". The
 *   snippet below uses `inherit! :complete` (the extension gets its own
 *   Pods-Chatyy-ChatyyBroadcastExtension aggregate with a real dependency
 *   on LiveKitClient). The plugin was never re-registered in app.json after
 *   that fix, so no build ever embedded the .appex and Info.plist never got
 *   `RTCScreenSharingExtension` / `RTCAppGroupIdentifier` — the native call
 *   screens silently fell back to LiveKit's in-app capturer (app window only).
 *
 * GATE (so a build without provisioning for the new bundle id still ships):
 *   The target + Info.plist keys are only added when ONE of these holds —
 *     CHATYY_BROADCAST_EXT=1              (eas.json build.production.env, set by
 *                                          scripts/asc-create-broadcast-profile.js;
 *                                          GitHub ios-build-local.yml prebuild step)
 *     IOS_PROFILE_BROADCAST_BASE64 / BROADCAST_UUID in env (GitHub CI)
 *     credentials/chatyy-broadcast.mobileprovision exists (local / Mac builds)
 *   CHATYY_BROADCAST_EXT=0 forces it OFF. When OFF the plugin is a no-op and
 *   logs a notice; ScreenShareSupport.swift then uses in-app capture and the
 *   chip says "Compartilhando tela do app".
 *
 * WHAT IT DOES (when ON):
 *   1. Writes the extension sources (SampleHandler.swift, Info.plist,
 *      entitlements) from the embedded strings below into
 *      `${platformProjectRoot}/ChatyyBroadcastExtension/` on every prebuild
 *      (ios/ is gitignored and regenerated on EAS, so embedded is canonical).
 *   2. Adds a PBXNativeTarget (app_extension) with bundle id
 *      com.onemundo.mail.broadcast, embeds it in the Chatyy app target, and
 *      registers the target dependency CocoaPods needs to find the host.
 *   3. App Group `group.com.onemundo.mail` on the main app (already there for
 *      ShareExtension) and on the extension (own entitlements file). LiveKit's
 *      BroadcastScreenCapturer / LKSampleHandler talk over a Unix socket in
 *      this App Group container.
 *   4. Host Info.plist: `RTCAppGroupIdentifier` + `RTCScreenSharingExtension`
 *      — the keys LiveKit Swift (and react-native-webrtc) read to find the
 *      extension and present RPSystemBroadcastPickerView pre-targeted at it.
 *   5. Podfile: nested `target 'ChatyyBroadcastExtension'` inside the Chatyy
 *      target with `inherit! :complete` + `pod 'LiveKitClient', '~> 2.0'`,
 *      and a post_install hook that drops the auto-generated
 *      ExpoModulesProvider.swift from the extension's Compile Sources.
 *
 * PROVISIONING (not done by this plugin — see scripts/asc-create-broadcast-profile.js):
 *   bundle id com.onemundo.mail.broadcast with APP_GROUPS capability linked to
 *   group.com.onemundo.mail, an App Store profile for it, credentials.json
 *   entry `ios.ChatyyBroadcastExtension`, GitHub secret
 *   IOS_PROFILE_BROADCAST_BASE64, Mac 207 profile install.
 */

const fs = require('fs');
const path = require('path');
const { withXcodeProject, withEntitlementsPlist, withInfoPlist, withDangerousMod } = require('expo/config-plugins');

const EXT_NAME = 'ChatyyBroadcastExtension';
const EXT_BUNDLE_ID = 'com.onemundo.mail.broadcast';
const APP_GROUP = 'group.com.onemundo.mail';
const DEPLOYMENT_TARGET = '16.0'; // = expo-build-properties ios.deploymentTarget in app.json
const LOCAL_PROFILE_PATH = path.join('credentials', 'chatyy-broadcast.mobileprovision');

// =====================================================================
// GATE
// =====================================================================

function broadcastGate(projectRoot) {
  const force = (process.env.CHATYY_BROADCAST_EXT || '').trim().toLowerCase();
  if (force === '0' || force === 'false' || force === 'off') return { on: false, why: 'CHATYY_BROADCAST_EXT=0' };
  if (force === '1' || force === 'true' || force === 'on') return { on: true, why: 'CHATYY_BROADCAST_EXT=1' };
  if (process.env.IOS_PROFILE_BROADCAST_BASE64 || process.env.BROADCAST_UUID) {
    return { on: true, why: 'broadcast provisioning profile present in CI env' };
  }
  if (projectRoot && fs.existsSync(path.join(projectRoot, LOCAL_PROFILE_PATH))) {
    return { on: true, why: `${LOCAL_PROFILE_PATH} present` };
  }
  return {
    on: false,
    why: `no provisioning for ${EXT_BUNDLE_ID} — run scripts/asc-create-broadcast-profile.js (sets CHATYY_BROADCAST_EXT=1 in eas.json)`,
  };
}

// =====================================================================
// EMBEDDED SOURCE FILES (canonical — ios/ is regenerated on every prebuild)
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
\t<string>Chatyy</string>
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
\t<string>$(MARKETING_VERSION)</string>
\t<key>CFBundleVersion</key>
\t<string>$(CURRENT_PROJECT_VERSION)</string>
\t<key>RTCAppGroupIdentifier</key>
\t<string>${APP_GROUP}</string>
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

// LiveKit-documented pattern: subclass LKSampleHandler and nothing else. The
// base class connects to the host over the App Group socket (it reads
// `RTCAppGroupIdentifier` from the EXTENSION's Info.plist above), encodes the
// CMSampleBuffers and the host's BroadcastScreenCapturer publishes them as
// the Room's screen-share track. Any extra override here (custom audio IPC,
// JPEG dumps, non-existent properties) is a compile/runtime risk — keep it
// minimal.
const SAMPLE_HANDLER_SWIFT = `//
//  SampleHandler.swift
//  ChatyyBroadcastExtension
//
//  ReplayKit Broadcast Upload Extension entry point. LKSampleHandler
//  (LiveKitClient pod) owns the whole pipeline: socket in the App Group
//  container (RTCAppGroupIdentifier) -> host app's LiveKit Room screen-share
//  track. Generated by plugins/with-broadcast-extension.js — edit it THERE.
//

import ReplayKit
import LiveKit

class SampleHandler: LKSampleHandler {
    override var enableLogging: Bool { true }
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
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const destDir = path.join(cfg.modRequest.platformProjectRoot, EXT_NAME);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      for (const [fileName, content] of Object.entries(EMBEDDED_FILES)) {
        fs.writeFileSync(path.join(destDir, fileName), content, 'utf8');
      }
      return cfg;
    },
  ]);
}

function withMainAppGroup(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
}

// Host Info.plist keys read by LiveKit Swift's BroadcastScreenCapturer (and
// by @livekit/react-native-webrtc's ScreenCaptureController /
// ScreenCapturePickerViewManager) to locate the extension + App Group.
function withBroadcastInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.RTCAppGroupIdentifier = APP_GROUP;
    cfg.modResults.RTCScreenSharingExtension = EXT_BUNDLE_ID;
    return cfg;
  });
}

function withBroadcastTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;

    // xcode npm quirk (see with-notification-service.js): when these sections
    // don't exist yet, addTarget's internal addTargetDependency silently
    // fails and CocoaPods can't infer the host ("Unable to find host target").
    const projObjects = project.hash.project.objects;
    projObjects.PBXTargetDependency = projObjects.PBXTargetDependency || {};
    projObjects.PBXContainerItemProxy = projObjects.PBXContainerItemProxy || {};

    // Idempotency — skip if already added
    const existingTarget = project.pbxNativeTargetSection?.() || {};
    for (const key of Object.keys(existingTarget)) {
      const t = existingTarget[key];
      if (t && typeof t === 'object' && t.name === EXT_NAME) return cfg;
    }

    const group = project.addPbxGroup(
      ['SampleHandler.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
      EXT_NAME,
      EXT_NAME,
      '"<group>"'
    );
    const rootGroup = project.getFirstProject()['firstProject']['mainGroup'];
    project.addToPbxGroup(group.uuid, rootGroup);

    const target = project.addTarget(EXT_NAME, 'app_extension', EXT_NAME, EXT_BUNDLE_ID);

    project.addBuildPhase(['SampleHandler.swift'], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase(['ReplayKit.framework'], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    // Host = the app-type target (NOT getFirstTarget: expo-share-intent's
    // ShareExtension may be first; extensions can't embed extensions).
    let mainAppTargetUuid = null;
    const nativeTargets = project.pbxNativeTargetSection() || {};
    for (const key of Object.keys(nativeTargets)) {
      const t = nativeTargets[key];
      if (t && typeof t === 'object' && t.productType === '"com.apple.product-type.application"') {
        const uuid = key.replace(/_comment$/, '');
        if (!/^[A-F0-9]+$/i.test(uuid)) continue;
        mainAppTargetUuid = uuid;
        break;
      }
    }
    if (!mainAppTargetUuid) {
      console.warn('[with-broadcast-extension] No app-type target found — falling back to getFirstTarget');
      mainAppTargetUuid = project.getFirstTarget().uuid;
    }
    project.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed App Extensions', mainAppTargetUuid, 'app_extension');
    try {
      project.addTargetDependency(mainAppTargetUuid, [target.uuid]);
    } catch (e) {
      console.warn('[with-broadcast-extension] addTargetDependency failed:', e?.message || e);
    }

    const xcConfig = project.pbxXCBuildConfigurationSection();
    // App Store validation wants the extension's CFBundleShortVersionString /
    // CFBundleVersion to match the containing app. Copy the literal values
    // Expo wrote on the app target (MARKETING_VERSION / CURRENT_PROJECT_VERSION
    // come from app.json version + ios.buildNumber, already auto-incremented
    // by EAS at this point). Fall back to the Expo config values.
    // Expo config first (app.json version / ios.buildNumber — EAS autoIncrement
    // bumps these before prebuild). The app target's own MARKETING_VERSION /
    // CURRENT_PROJECT_VERSION build settings are a stale "1.0"/"1" in the Expo
    // template (the real values live in the app's Info.plist), so they are
    // only a last-resort fallback.
    let marketingVersion = cfg.version ? `${cfg.version}` : null;
    let projectVersion = (cfg.ios && cfg.ios.buildNumber) ? `${cfg.ios.buildNumber}` : null;
    if (!marketingVersion || !projectVersion) {
      for (const key of Object.keys(xcConfig)) {
        const c = xcConfig[key];
        if (c && c.buildSettings && `${c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER || ''}`.replace(/"/g, '') === 'com.onemundo.mail') {
          if (!marketingVersion && c.buildSettings.MARKETING_VERSION) marketingVersion = `${c.buildSettings.MARKETING_VERSION}`.replace(/"/g, '');
          if (!projectVersion && c.buildSettings.CURRENT_PROJECT_VERSION) projectVersion = `${c.buildSettings.CURRENT_PROJECT_VERSION}`.replace(/"/g, '');
          break;
        }
      }
    }
    marketingVersion = marketingVersion || '1.0';
    projectVersion = projectVersion || '1';
    for (const key of Object.keys(xcConfig)) {
      const c = xcConfig[key];
      if (c && c.buildSettings && c.buildSettings.PRODUCT_NAME === `"${EXT_NAME}"`) {
        const s = c.buildSettings;
        s.INFOPLIST_FILE = `"${EXT_NAME}/Info.plist"`;
        s.CODE_SIGN_ENTITLEMENTS = `"${EXT_NAME}/${EXT_NAME}.entitlements"`;
        s.IPHONEOS_DEPLOYMENT_TARGET = `"${DEPLOYMENT_TARGET}"`;
        s.SWIFT_VERSION = '5.0';
        s.PRODUCT_BUNDLE_IDENTIFIER = `"${EXT_BUNDLE_ID}"`;
        s.CODE_SIGN_STYLE = '"Automatic"'; // EAS (credentials.json) / patch-broadcast-signing.js / withManualIosSigning flip to Manual
        s.TARGETED_DEVICE_FAMILY = '"1,2"';
        s.MARKETING_VERSION = `"${marketingVersion}"`;
        s.CURRENT_PROJECT_VERSION = `"${projectVersion}"`;
        s.SKIP_INSTALL = 'YES';
        // [2026-10-06 build 635 ERRORED] Xcode (15+) REFUSES an app-extension
        // target with APPLICATION_EXTENSION_API_ONLY=NO: "Application extensions
        // and any libraries they link to must be built with ... YES (in target
        // 'ChatyyBroadcastExtension')". Must be YES. The extension now has its
        // OWN top-level Pods aggregate (only LiveKitClient + deps, no RN) — see
        // withBroadcastPodTarget — so no app-only pod gets linked into it.
        s.APPLICATION_EXTENSION_API_ONLY = 'YES';
        s.LD_RUNPATH_SEARCH_PATHS = '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
      }
    }
    return cfg;
  });
}

// Nested Podfile target so LiveKitClient is linked into the extension.
// `inherit! :complete` (NOT :search_paths — see header) gives the extension
// its own pods aggregate with a hard dependency on LiveKitClient, so the
// Swift module exists before SampleHandler.swift compiles.
function withBroadcastPodTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      const pod = fs.readFileSync(podfilePath, 'utf8');
      const marker = `target '${EXT_NAME}' do`;
      if (pod.includes(marker)) return cfg;

      const lines = pod.split('\n');
      // Locate `target 'Chatyy' do` (slug fallback) then its matching `end`,
      // counting Ruby block openers so inner if/else/do blocks don't fool us.
      let mainLine = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*target\s+['"]([^'"]+)['"]\s+do\b/.exec(lines[i]);
        if (m && (m[1] === 'Chatyy' || m[1] === 'OneMundoMail')) { mainLine = i; break; }
      }
      if (mainLine === -1) {
        for (let i = 0; i < lines.length; i++) {
          const m = /^\s*target\s+['"]([^'"]+)['"]\s+do\b/.exec(lines[i]);
          if (m && ![EXT_NAME, 'ShareExtension', 'ChatyyNotificationService', 'NotificationService'].includes(m[1])) {
            mainLine = i;
            console.log(`[with-broadcast-extension] fallback: nesting inside '${m[1]}'`);
            break;
          }
        }
      }
      if (mainLine === -1) {
        console.warn('[with-broadcast-extension] No main app target found in Podfile — skipping pod target');
        return cfg;
      }
      // Insert the nested target RIGHT AFTER `target 'Chatyy' do`. Earlier
      // versions walked to the main target's closing `end` by counting Ruby
      // block openers, but statement-form `if removed > 0` lines inside the
      // post_install hooks (NSE provider stub) were mis-classified as
      // modifiers, the count came up one short, and the nested target landed
      // INSIDE `post_install do |installer| ... end` — where CocoaPods silently
      // ignores it (no LiveKitClient linked → "no such module 'LiveKit'").
      // Position inside the parent block is irrelevant to CocoaPods: the DSL
      // is fully evaluated before dependency inheritance is resolved.
      // [2026-10-06 build 635] TOP-LEVEL target (inserted BEFORE the main
      // target, NOT nested): the appex gets its own Pods aggregate with only
      // LiveKitClient (+ its deps). Nested + `inherit! :complete` dragged the
      // whole RN pod set into the extension (50MB ReplayKit limit) and those
      // pods are built with APPLICATION_EXTENSION_API_ONLY=NO; nested +
      // `inherit! :search_paths` deduped LiveKitClient away ("no such module").
      // A sibling target shares the LiveKitClient pod target (one version,
      // resolved once by CocoaPods) with a hard dependency, so the module is
      // built before SampleHandler.swift compiles.
      const insertAt = mainLine;
      const nested = [
        `# [2026-10-06 screen-share iOS] Auto-injected by plugins/with-broadcast-extension.js.`,
        `# Top-level (sibling) target: only LiveKitClient is linked into the appex.`,
        `target '${EXT_NAME}' do`,
        `  platform :ios, '${DEPLOYMENT_TARGET}'`,
        `  pod 'LiveKitClient', '~> 2.0'`,
        `end`,
        ``,
      ];
      lines.splice(insertAt, 0, ...nested);
      fs.writeFileSync(podfilePath, lines.join('\n'));
      console.log(`[with-broadcast-extension] Injected top-level ${EXT_NAME} pod target before main target line ${mainLine + 1}`);
      return cfg;
    },
  ]);
}

// expo-modules-core's "[Expo] Configure project" phase regenerates an
// ExpoModulesProvider.swift for EVERY target on each build. The extension
// doesn't host React/Expo, so strip the file from its Compile Sources in
// post_install (same approach as with-notification-service.js). Keeps the
// appex lean and immune to provider/module mismatches.
function withBroadcastProviderStub(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      let pod = fs.readFileSync(podfilePath, 'utf8');
      const sentinel = '# BROADCAST_REMOVE_PROVIDER_v1';
      if (pod.includes(sentinel)) return cfg;
      const hook = [
        '',
        '  ' + sentinel,
        '  begin',
        '    bc_project_path = installer.aggregate_targets.first.user_project_path',
        '    bc_project = Xcodeproj::Project.open(bc_project_path)',
        `    bc_target = bc_project.targets.find { |t| t.name == '${EXT_NAME}' }`,
        '    if bc_target',
        '      bc_removed = 0',
        '      bc_target.source_build_phase.files.dup.each do |build_file|',
        '        ref = build_file.file_ref',
        '        p = ref && (ref.respond_to?(:path) ? ref.path : nil)',
        '        d = ref && ref.respond_to?(:display_name) ? ref.display_name : nil',
        "        if (p && p.include?('ExpoModulesProvider.swift')) || d == 'ExpoModulesProvider.swift'",
        '          bc_target.source_build_phase.remove_build_file(build_file)',
        '          bc_removed += 1',
        '        end',
        '      end',
        '      bc_project.save if bc_removed > 0',
        `      Pod::UI.puts "[broadcast fix] Removed #{bc_removed} ExpoModulesProvider.swift entries from ${EXT_NAME} sources"`,
        '    else',
        `      Pod::UI.puts "[broadcast fix] target ${EXT_NAME} not found in user project (plugin gated off?)"`,
        '    end',
        '  rescue => e',
        '    Pod::UI.puts "[broadcast fix] ERROR: #{e.class}: #{e.message}"',
        '    raise',
        '  end',
        '  # [2026-10-06 build 636 ERRORED] CocoaPods sets APPLICATION_EXTENSION_API_ONLY=YES',
        '  # on every pod the appex depends on → LiveKitClient fails to compile',
        '  # ("LKRTCCameraVideoCapturer is unavailable in application extensions",',
        '  # CameraCapturer.swift / VideoView+PinchToZoom.swift). The extension only',
        '  # uses LKSampleHandler (socket IPC, no camera), so build those pods with',
        '  # NO — same approach RN apps use for pods shared with extensions. The',
        '  # appex target itself stays YES (Xcode requires it).',
        '  begin',
        `    bc_agg = installer.aggregate_targets.find { |a| a.name == 'Pods-${EXT_NAME}' }`,
        '    bc_names = bc_agg ? bc_agg.pod_targets.map(&:name) : []',
        '    bc_fixed = 0',
        '    installer.pods_project.targets.each do |t|',
        '      next unless bc_names.any? { |n| t.name == n || t.name.start_with?(n + "-") }',
        '      t.build_configurations.each { |c| c.build_settings["APPLICATION_EXTENSION_API_ONLY"] = "NO"; bc_fixed += 1 }',
        '    end',
        `    Pod::UI.puts "[broadcast fix] APPLICATION_EXTENSION_API_ONLY=NO on #{bc_fixed} configs of #{bc_names.inspect}"`,
        '  rescue => e',
        '    Pod::UI.puts "[broadcast fix] ext-api-only ERROR: #{e.class}: #{e.message}"',
        '  end',
        '',
      ].join('\n');
      const re = /(post_install\s+do\s*\|installer\|)/;
      if (re.test(pod)) pod = pod.replace(re, `$1\n${hook}`);
      else pod += `\n\npost_install do |installer|\n${hook}\nend\n`;
      fs.writeFileSync(podfilePath, pod);
      return cfg;
    },
  ]);
}

module.exports = function withBroadcastExtension(config) {
  const projectRoot = (config._internal && config._internal.projectRoot) || process.cwd();
  const gate = broadcastGate(projectRoot);
  if (!gate.on) {
    console.log(`[with-broadcast-extension] OFF — ${gate.why}. iOS screen share falls back to in-app capture.`);
    return config;
  }
  console.log(`[with-broadcast-extension] ON — ${gate.why}`);
  config = withBroadcastExtensionFiles(config);
  config = withMainAppGroup(config);
  config = withBroadcastInfoPlist(config);
  config = withBroadcastTarget(config);
  config = withBroadcastPodTarget(config);
  config = withBroadcastProviderStub(config);
  return config;
};

module.exports.EXT_NAME = EXT_NAME;
module.exports.EXT_BUNDLE_ID = EXT_BUNDLE_ID;
module.exports.APP_GROUP = APP_GROUP;
module.exports.LOCAL_PROFILE_PATH = LOCAL_PROFILE_PATH;
module.exports.broadcastGate = broadcastGate;

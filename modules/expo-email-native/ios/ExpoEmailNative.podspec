require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoEmailNative'
  s.version        = package['version']
  s.summary        = 'Chatyy native e-mail reader body + rich compose editor'
  s.description    = 'WKWebView e-mail body (content JS off, WKContentRuleList remote blocking, auto height, pinch zoom, link menu) and TextKit 1 rich editor (bold/italic/underline/strike/lists/quote/link) with HTML import/export.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'WebKit', 'QuartzCore'
end

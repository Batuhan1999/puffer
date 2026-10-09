Pod::Spec.new do |s|
  s.name           = 'PufferCore'
  s.version        = '0.2.0'
  s.summary        = 'On-device index, search, consent and embeddings for Puffer'
  s.author         = ''
  s.homepage       = 'https://github.com/google-ai-edge/LiteRT-LM'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  # DEFINES_MODULE lets the app-target intents `import PufferCore`.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  s.source_files = ['*.swift', 'vendor/LiteRTLM/*.swift']
  s.vendored_frameworks = 'vendor/CLiteRTLM.xcframework'
  s.frameworks = 'PDFKit', 'CoreSpotlight', 'Accelerate'
  s.libraries = 'sqlite3'
end

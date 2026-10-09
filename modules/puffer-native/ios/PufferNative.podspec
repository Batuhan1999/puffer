Pod::Spec.new do |s|
  s.name           = 'PufferNative'
  s.version        = '0.2.0'
  s.summary        = 'Puffer search engine, agent bridge and system hooks'
  s.description    = 'Local Expo module: item store, ranking and EmbeddingGemma 2 through the LiteRT-LM v0.18.0 Swift EmbeddingEngine, plus policy, relay sync and system hooks.'
  s.author         = ''
  s.homepage       = 'https://github.com/google-ai-edge/LiteRT-LM'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoUI'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = ['*.swift', 'Editor/*.swift', 'vendor/LiteRTLM/*.swift']
  s.vendored_frameworks = 'vendor/CLiteRTLM.xcframework'
  s.frameworks = 'PDFKit', 'PencilKit', 'PhotosUI', 'QuickLook', 'VisionKit'
  s.libraries = 'sqlite3'
end

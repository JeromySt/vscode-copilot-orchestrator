{
    "targets": [
        {
            "target_name": "ai_orchestrator_bindings",
            "sources": [ "src/native/bindings.cc" ],
            "include_dirs": [
                "<!@(node -p \"require('node-addon-api').include\")"
            ],
            "defines": [ "NAPI_VERSION=8" ]
        }
    ]
}

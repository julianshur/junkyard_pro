$ErrorActionPreference = "Stop"

$nodeCandidates = @(
  "$env:LOCALAPPDATA\OpenAI\Codex\bin\5b9024f90663758b\node.exe",
  "$env:ProgramFiles\WindowsApps\OpenAI.Codex_26.519.5221.0_x64__2p2nqsd0c76g0\app\resources\node.exe"
)

$node = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $node) {
  throw "Could not find the bundled Node runtime. Install Node.js or run this from inside Codex."
}

$env:PORT = if ($env:PORT) { $env:PORT } else { "5180" }
& $node "$PSScriptRoot\server.js"

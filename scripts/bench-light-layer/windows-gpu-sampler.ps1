# Chrome's GPU process on Windows: its CPU time (ms) every half second, with the epoch
# time in ms and its PID. Read-only. Run for the given minutes, output to a file:
#   powershell -NoProfile -File windows-gpu-sampler.ps1 25 > samples.txt
$end = (Get-Date).AddMinutes([double]$args[0])
while ((Get-Date) -lt $end) {
  $gpu = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '--type=gpu-process' } | Select-Object -First 1
  if ($gpu) {
    $p = Get-Process -Id $gpu.ProcessId -ErrorAction SilentlyContinue
    if ($p) { "{0} {1} {2}" -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $gpu.ProcessId, [math]::Round($p.TotalProcessorTime.TotalMilliseconds) }
  }
  Start-Sleep -Milliseconds 500
}

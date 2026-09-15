# 将 wuliao.local 指向本机（需管理员权限）
$hostsPath = "$env:WinDir\System32\drivers\etc\hosts"
if (-not (Select-String -Path $hostsPath -Pattern 'wuliao\.local' -Quiet)) {
  Add-Content -Path $hostsPath -Value "`r`n127.0.0.1 wuliao.local" -Encoding ASCII
  Write-Output "OK: wuliao.local -> 127.0.0.1"
} else {
  Write-Output "SKIP: wuliao.local 已存在"
}

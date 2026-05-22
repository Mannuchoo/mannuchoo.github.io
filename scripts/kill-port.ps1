param([int]$Port = 3000)

$line = & netstat -ano | findstr ":$Port "
if (-not $line) {
    Write-Output "No process found listening on port $Port"
    exit 0
}

# Netstat may return multiple lines; pick unique PIDs
$lines = $line -split "\r?\n"
$procIds = @()
foreach ($l in $lines) {
    $parts = $l -split '\s+' | Where-Object { $_ -ne '' }
    $procId = $parts[-1]
    if ($procId -and ($procIds -notcontains $procId)) { $procIds += $procId }
}

foreach ($procId in $procIds) {
    Write-Output "Killing PID $procId on port $Port"
    try {
        taskkill /PID $procId /F | Out-Null
        Write-Output "Killed PID $procId"
    } catch {
        Write-Output ("Failed to kill PID {0}: {1}" -f $procId, $_)
    }
}

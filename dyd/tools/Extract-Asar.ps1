param(
    [Parameter(Mandatory=$true)][string]$AsarPath,
    [Parameter(Mandatory=$true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($AsarPath)
try {
    $br = New-Object System.IO.BinaryReader($fs)

    # 8-byte prefix pickle: [payloadSize:u32][headerSize:u32]
    $null = $br.ReadUInt32()            # payload size of the size-pickle (=4)
    $headerPickleSize = $br.ReadUInt32() # number of bytes of the header pickle that follows

    $headerBytes = $br.ReadBytes([int]$headerPickleSize)
    # header pickle: [payloadSize:u32][strLen:u32][json bytes...]
    $strLen = [System.BitConverter]::ToUInt32($headerBytes, 4)
    $json = [System.Text.Encoding]::UTF8.GetString($headerBytes, 8, [int]$strLen)

    $baseOffset = 8 + [int]$headerPickleSize

    $header = $json | ConvertFrom-Json

    $manifest = New-Object System.Collections.Generic.List[string]

    function Walk($node, [string]$relPath) {
        if ($node.PSObject.Properties.Name -contains 'files') {
            foreach ($p in $node.files.PSObject.Properties) {
                $child = if ([string]::IsNullOrEmpty($relPath)) { $p.Name } else { "$relPath/$($p.Name)" }
                Walk $p.Value $child
            }
        } else {
            $size = [int64]$node.size
            $offset = [int64]::Parse([string]$node.offset)
            $abs = $baseOffset + $offset
            $outPath = Join-Path $OutDir $relPath
            $dir = Split-Path $outPath -Parent
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

            $fs.Seek($abs, [System.IO.SeekOrigin]::Begin) | Out-Null
            $remaining = $size
            $ofs = [System.IO.File]::Create($outPath)
            try {
                $buf = New-Object byte[] 1048576
                while ($remaining -gt 0) {
                    $toRead = [int][Math]::Min($buf.Length, $remaining)
                    $read = $fs.Read($buf, 0, $toRead)
                    if ($read -le 0) { break }
                    $ofs.Write($buf, 0, $read)
                    $remaining -= $read
                }
            } finally { $ofs.Close() }
            $manifest.Add(("{0}`t{1} bytes" -f $relPath, $size))
        }
    }

    Walk $header ''

    $manifest | Sort-Object | Set-Content -Path (Join-Path $OutDir '_manifest.txt') -Encoding UTF8
    Write-Host ("Extracted {0} files to {1}" -f $manifest.Count, $OutDir)
}
finally {
    $fs.Dispose()
}

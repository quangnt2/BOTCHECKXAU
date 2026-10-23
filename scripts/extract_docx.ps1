Add-Type -AssemblyName System.IO.Compression.FileSystem
$docPath = (Resolve-Path ".agents/input/Bò gấu bản gốc_1.docx").Path
$zip = [System.IO.Compression.ZipFile]::OpenRead($docPath)
$entry = $zip.GetEntry("word/document.xml")
$stream = $entry.Open()
$reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
$xmlContent = $reader.ReadToEnd()
$reader.Close()
$stream.Close()
$zip.Dispose()

# Parse XML to extract text with line breaks between paragraphs
$xml = [xml]$xmlContent
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main")

$paras = $xml.SelectNodes("//w:p", $ns)
$lines = @()
foreach ($p in $paras) {
    $tNodes = $p.SelectNodes(".//w:t", $ns)
    $pText = ""
    foreach ($t in $tNodes) {
        $pText += $t.InnerText
    }
    if ($pText.Trim().Length -gt 0) {
        $lines += $pText
    }
}

$outputFile = ".agents/input/bo_gau_extracted.txt"
[System.IO.File]::WriteAllLines($outputFile, $lines, [System.Text.Encoding]::UTF8)
Write-Host "Extracted $($lines.Count) paragraphs to $outputFile"

# The process tree under build123d Studio, for the Windows manual tests.
#
# `pstree -s build123d-studio` is what this replaces, and Windows has nothing
# equivalent: tasklist knows no parents, pslist -t prints the whole machine, and
# Process Explorer is a window rather than something a test can paste. So the
# tree is built here from Win32_Process, which is the only thing that carries
# ParentProcessId.
#
# What it is for: seeing which children a Studio window owns, and whether they
# are gone after it exits. The interesting ones are the sidecar, the kernel, the
# measurement process, and whatever uv spawns during an install - none of which
# are named "build123d-studio", so they are found by descent rather than by name.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ps-tree.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ps-tree.ps1 -Name python
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ps-tree.ps1 -Full
#
# -ExecutionPolicy Bypass because a downloaded or unsigned script is otherwise
# refused, and this is a diagnostic nobody should have to sign.

#Requires -Version 5.1
[CmdletBinding()]
param(
    # Matched against the process name, not the command line: the command line
    # of a Studio child is a Python path, and matching on that would pick up
    # every unrelated Python on the machine.
    [string]$Name = "build123d-studio",

    # Command lines are long - the sidecar's carries two absolute paths - so
    # they are cut unless this is given.
    [switch]$Full
)

$all = Get-CimInstance Win32_Process
if (-not $all) {
    Write-Error "Win32_Process returned nothing; this needs an ordinary user session."
    exit 2
}

$byId = @{}
$children = @{}
foreach ($p in $all) {
    $byId[[int]$p.ProcessId] = $p
    $parent = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($parent)) {
        $children[$parent] = New-Object System.Collections.ArrayList
    }
    [void]$children[$parent].Add($p)
}

function Write-Branch {
    param($Proc, [string]$Prefix, $Children, [bool]$ShowFull)

    $line = $Proc.CommandLine
    if (-not $line) { $line = $Proc.Name }
    if (-not $ShowFull -and $line.Length -gt 110) {
        $line = $line.Substring(0, 107) + "..."
    }
    "{0}{1,-7} {2}" -f $Prefix, $Proc.ProcessId, $line

    $kids = $Children[[int]$Proc.ProcessId]
    if ($kids) {
        foreach ($kid in ($kids | Sort-Object ProcessId)) {
            Write-Branch -Proc $kid -Prefix ($Prefix + "  ") -Children $Children -ShowFull $ShowFull
        }
    }
}

$matched = $all | Where-Object { $_.Name -like "*$Name*" } | Sort-Object ProcessId
if (-not $matched) {
    Write-Host "No process whose name matches *$Name*"
    exit 1
}

foreach ($proc in $matched) {
    # One subtree per *outermost* match. Without this, a match nested under
    # another match prints twice - once as a root and once as a child - which
    # for two Studio windows would read as four.
    $parent = $byId[[int]$proc.ParentProcessId]
    if ($parent -and $parent.Name -like "*$Name*") { continue }

    Write-Branch -Proc $proc -Prefix "" -Children $children -ShowFull $Full.IsPresent
    ""
}

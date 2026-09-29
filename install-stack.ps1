# MindStone, the whole stack in Docker, from Windows PowerShell (#180): the
# MindStone-Agent gateway, the MindStone Console and MongoDB, set up and started
# with one command. The PowerShell twin of install-stack.sh.
#
#   irm https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.ps1 | iex
#
# irm | iex takes no options: set $env:MINDSTONE_* variables first (see -Help),
# or run it as a script block, which takes them:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent/main/install-stack.ps1))) -AdminEmail you@example.com
#
# Runs on Windows PowerShell 5.1 and PowerShell 7 (and pwsh on macOS or Linux).
# Re-running it updates the stack. Secrets are generated once, into files only
# this user (and SYSTEM) can read, and never printed; existing secrets and data
# are never replaced.
#
# Everything runs inside Install-MindStoneStack, called on the last line with a
# closing argument it checks for, so a download cut off part-way runs nothing.
# This file is ASCII only, so Windows PowerShell 5.1 reads it the same from a
# saved file as from irm.

function Install-MindStoneStack {
    # The installer talks to the person at the console, as install-stack.sh does with printf;
    # Write-Host output is the Information stream on 5.1 and 7, so it can still be redirected (6>).
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Console installer output.')]
    # No positional parameters: a stray word or a bash-style --option is caught
    # below (as Unexpected) instead of becoming the install folder.
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$Dir,
        [string]$Ref,
        [string]$ConsoleRef,
        [string]$AdminEmail,
        [string]$AdminName,
        [switch]$WithOllama,
        [switch]$WithoutOllama,
        [string]$OllamaUrl,
        [switch]$Uninstall,
        [switch]$Help,
        # Set only by the script's last line: without it, the download was cut off.
        [string]$EndOfScript,
        # Anything else given, such as a bash-style --with-ollama.
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Unexpected
    )

    # Under AppLocker or WDAC, PowerShell runs scripts in ConstrainedLanguage mode,
    # where the .NET calls below are refused. Checked first, with nothing but a string.
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        Write-Host "[MindStone install error] PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode here (an AppLocker or WDAC policy), and the installer needs FullLanguage. Run it where scripts are allowed, or ask your administrator; the WSL 2 route in the README is an alternative."
        throw 'The MindStone install stopped; see the message above.'
    }

    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $RawMsa = 'https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent'
    $RawConsole = 'https://raw.githubusercontent.com/MindStone-Agent/mindstone-console'
    $InstallUrl = "$RawMsa/main/install-stack.ps1"
    $DefaultDirName = '.mindstone-stack'
    # The file that marks a folder as this installer's, so -Dir never takes over another folder.
    $Marker = '.mindstone-stack'
    $HostOllamaUrl = 'http://host.docker.internal:11434/v1'
    $StackOllamaUrl = 'http://ollama:11434/v1'
    # The Console's database: a named Docker volume (compose.yml declares it). MongoDB
    # on a Windows host folder is unreliable. The volume is owned by the image's
    # mongodb user (999), so mongod runs as that user.
    $MongoVolume = 'mongo-data'
    $MongoUser = '999:999'
    # Everything the installer creates in the install folder, and nothing else:
    # the printed delete removes exactly these.
    $CreatedFiles = @('compose.yml', 'librechat.yaml', 'console.env.example', '.env', 'gateway.env', 'console.env', 'admin-password', '.admin-created', $Marker)
    # Every COMPOSE_* variable, and every variable compose.yml reads, comes from .env
    # only: the installer's own docker compose commands run without them.
    $ComposeEnvPattern = '^(COMPOSE_.*|OLLAMA_BASE_URL|CONSOLE_PORT|MINDSTONE_GATEWAY_PORT|MINDSTONE_REF|CONSOLE_REF|MINDSTONE_BUILD_CONTEXT|CONSOLE_BUILD_CONTEXT|MINDSTONE_MONGO_DATA|MINDSTONE_MONGO_USER|UID|GID)$'
    $OnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $PathComparison = [StringComparison]::Ordinal
    if ($OnWindows) { $PathComparison = [StringComparison]::OrdinalIgnoreCase }
    # What the helpers share: the install folder, its .env, the project, docker's path.
    $S = @{ InstallDir = ''; EnvFile = ''; Project = ''; Docker = ''; Sid = '' }

    # -------------------------------------------------------------------------
    # Output

    function Write-InstallLog([string]$Message) {
        Write-Host '[MindStone] ' -ForegroundColor DarkYellow -NoNewline
        Write-Host $Message
    }

    function Write-InstallWarning([string]$Message) {
        Write-Host '[MindStone warning] ' -ForegroundColor Yellow -NoNewline
        Write-Host $Message
    }

    function Exit-Install([string]$Message) {
        $exception = New-Object System.Exception $Message
        $exception.Data['MindStoneInstallError'] = $true
        throw $exception
    }

    # A value quoted for PowerShell, for the commands the installer prints.
    function Format-Quoted([string]$Text) {
        return "'" + $Text.Replace("'", "''") + "'"
    }

    function Show-Usage {
        Write-Host @"
MindStone stack installer: the MindStone-Agent gateway, the MindStone Console and
MongoDB in Docker Desktop.

Usage:
  irm $InstallUrl | iex
  & ([scriptblock]::Create((irm $InstallUrl))) [options]

Options:
  -Dir PATH           Install folder. Default: `$HOME\$DefaultDirName. It must be new,
                      empty, or an earlier stack install
  -Ref REF            MindStone-Agent git ref to install. Default: main
  -ConsoleRef REF     MindStone Console git ref to install. Default: main
  -AdminEmail EMAIL   Create the Console admin without prompts: the password is
                      generated into <dir>\admin-password (this user only), never printed
  -AdminName NAME     The admin's display name, 3 to 80 characters. Default: Admin
  -WithOllama         Also run Ollama in a container (no Ollama on this machine)
  -WithoutOllama      Go back to Ollama on this machine (undoes -WithOllama)
  -OllamaUrl URL      Ollama as the gateway container sees it, ending in /v1.
                      Default: $HostOllamaUrl
  -Uninstall          Stop and remove the stack's containers. Data is kept
  -Help               Show this help

Environment (only these names are read; COMPOSE_* and the other variables
compose.yml uses come from <dir>\.env only, and are removed for the installer's
own docker compose commands). With irm | iex, set them first:
  MINDSTONE_DIR, MINDSTONE_REF, CONSOLE_REF
  CONSOLE_PORT               the Console's port on 127.0.0.1. Default: 3080
  MINDSTONE_GATEWAY_PORT     the gateway's port on 127.0.0.1. Default: 19789
  MINDSTONE_PROJECT          the Docker Compose project name. Default: mindstone-stack
  MINDSTONE_OLLAMA_BASE_URL  same as -OllamaUrl
  MINDSTONE_ADMIN_EMAIL, MINDSTONE_ADMIN_NAME   same as -AdminEmail, -AdminName
  MINDSTONE_WITH_OLLAMA=1, MINDSTONE_WITHOUT_OLLAMA=1, MINDSTONE_UNINSTALL=1
For example:
  `$env:CONSOLE_PORT = '3090'; `$env:MINDSTONE_ADMIN_EMAIL = 'you@example.com'
  irm $InstallUrl | iex
A `$env: variable lasts until this PowerShell window closes, and applies to every
run in it: remove it with Remove-Item Env:\NAME.

Your own changes to the stack (a GPU for Ollama, extra mounts) go in
<dir>\compose.override.yml: the installer uses it and never overwrites it.
"@
    }

    # -------------------------------------------------------------------------
    # Processes. Arguments are quoted here (Windows command-line rules, which .NET
    # also applies on macOS and Linux), so a name with quotes or spaces reaches the
    # program as one argument on Windows PowerShell 5.1 too. Output is read as
    # UTF-8, and input is written as UTF-8 with a bare LF.

    function ConvertTo-NativeArgument([string]$Value) {
        if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
        $builder = New-Object System.Text.StringBuilder
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($ch in $Value.ToCharArray()) {
            if ($ch -eq [char]92) {
                $slashes++
                continue
            }
            if ($ch -eq [char]34) {
                [void]$builder.Append([char]92, 2 * $slashes + 1)
            } elseif ($slashes -gt 0) {
                [void]$builder.Append([char]92, $slashes)
            }
            [void]$builder.Append($ch)
            $slashes = 0
        }
        if ($slashes -gt 0) { [void]$builder.Append([char]92, 2 * $slashes) }
        [void]$builder.Append('"')
        return $builder.ToString()
    }

    # Runs a program. With -Capture, returns ExitCode, Output and Errors, and
    # writes InputText (if any) to its stdin; without, it shares this console and
    # the exit code is returned. -ComposeEnv removes the variables compose.yml reads.
    function Invoke-Native {
        param(
            [string]$FilePath,
            [string[]]$ArgumentList,
            [switch]$Capture,
            [string]$InputText,
            [switch]$ComposeEnv
        )
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $FilePath
        $info.Arguments = (@($ArgumentList | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
        $info.UseShellExecute = $false
        if ($ComposeEnv) {
            foreach ($name in @($info.EnvironmentVariables.Keys)) {
                if ($name -match $ComposeEnvPattern) { $info.EnvironmentVariables.Remove($name) }
            }
        }
        if (-not $Capture) {
            $process = [System.Diagnostics.Process]::Start($info)
            $process.WaitForExit()
            return $process.ExitCode
        }
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = $Utf8NoBom
        $info.StandardErrorEncoding = $Utf8NoBom
        # .NET Framework (Windows PowerShell 5.1) builds the child's stdin writer from
        # [Console]::InputEncoding and writes its preamble at once: with code page
        # 65001 that is a UTF-8 BOM in front of the password. A BOM-less UTF-8 for
        # the start, then the console's own again. (.NET Core writes no preamble.)
        # Test only, for the Windows check in PR #181: MINDSTONE_TEST_STDIN_BOM=1 lets
        # the BOM through (5.1 skips this fix; PowerShell 7 writes the BOM that .NET
        # Framework would), to show the sign-in check catching a changed password.
        $letBomThrough = [Environment]::GetEnvironmentVariable('MINDSTONE_TEST_STDIN_BOM') -eq '1'
        $savedInputEncoding = $null
        if ($PSVersionTable.PSVersion.Major -lt 6 -and -not $letBomThrough) {
            try {
                $savedInputEncoding = [Console]::InputEncoding
                [Console]::InputEncoding = $Utf8NoBom
            } catch {
                # No console (the ISE): the default encoding is then a code page without a preamble.
                $savedInputEncoding = $null
            }
        }
        try {
            $process = [System.Diagnostics.Process]::Start($info)
        } finally {
            if ($null -ne $savedInputEncoding) {
                try { [Console]::InputEncoding = $savedInputEncoding } catch { Write-Verbose 'The console encoding could not be restored.' }
            }
        }
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if ($InputText) {
            $bytes = $Utf8NoBom.GetBytes($InputText)
            if ($letBomThrough -and $PSVersionTable.PSVersion.Major -ge 6) { $bytes = [byte[]](@(0xEF, 0xBB, 0xBF) + $bytes) }
            try {
                $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
                $process.StandardInput.BaseStream.Flush()
            } catch {
                # The program exited without reading its input; its exit code says why.
                Write-Verbose 'The program did not read its input.'
            }
            $bytes = $null
        }
        try { $process.StandardInput.Close() } catch { Write-Verbose 'stdin was already closed.' }
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $outTask.Result; Errors = $errTask.Result }
    }

    # docker compose for this install: its folder, its .env, compose.override.yml
    # when present, and none of this session's COMPOSE_* or stack variables,
    # which would override .env.
    function Invoke-Compose {
        param([string[]]$ArgumentList, [switch]$Capture, [string]$InputText)
        $all = @('compose', '--project-directory', $S.InstallDir, '-f', [IO.Path]::Combine($S.InstallDir, 'compose.yml'))
        $override = [IO.Path]::Combine($S.InstallDir, 'compose.override.yml')
        if ([IO.File]::Exists($override)) { $all += @('-f', $override) }
        $all += $ArgumentList
        return Invoke-Native -FilePath $S.Docker -ArgumentList $all -Capture:$Capture -InputText $InputText -ComposeEnv
    }

    # -------------------------------------------------------------------------
    # Files. Env files are read with or without a BOM and with LF or CRLF, and
    # written as UTF-8 without a BOM, with LF: Docker's env-file parser and the
    # Console's dotenv read them in the containers.

    function Get-RandomHex([int]$Bytes) {
        $buffer = New-Object byte[] $Bytes
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
        return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
    }

    function Get-Sha256Hex([byte[]]$Bytes) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hash = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    }

    # This user only (and SYSTEM, which can read every file anyway): the Windows
    # equivalent of mode 600, or of 700 for a folder (inherited by what's in it).
    # Checked afterwards: any other allow rule stops the install.
    function Protect-Path([string]$Path, [switch]$Directory) {
        if (-not $OnWindows) {
            $mode = '600'
            if ($Directory) { $mode = '700' }
            $result = Invoke-Native -FilePath 'chmod' -ArgumentList @($mode, $Path) -Capture
            if ($result.ExitCode -ne 0) { Exit-Install "Could not restrict who can read $Path (chmod $mode failed)." }
            return
        }
        if (-not $S.Sid) { $S.Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
        $rights = 'F'
        if ($Directory) { $rights = '(OI)(CI)F' }
        # /reset drops rules set on the item itself; /inheritance:r then drops the
        # inherited ones, and /grant:r leaves this user and SYSTEM.
        $reset = Invoke-Native -FilePath 'icacls.exe' -ArgumentList @($Path, '/reset', '/q') -Capture
        $grant = Invoke-Native -FilePath 'icacls.exe' -ArgumentList @($Path, '/inheritance:r', '/grant:r', "*$($S.Sid):$rights", "*S-1-5-18:$rights", '/q') -Capture
        if ($reset.ExitCode -ne 0 -or $grant.ExitCode -ne 0) {
            Exit-Install "Could not restrict who can read $Path (icacls failed: $(($reset.Output + $reset.Errors + $grant.Output + $grant.Errors).Trim())). Is it on an NTFS drive?"
        }
        $acl = Get-Acl -LiteralPath $Path
        if (-not $acl.AreAccessRulesProtected) { Exit-Install "$Path still inherits its permissions from its folder." }
        foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
            $sid = $rule.IdentityReference.Value
            if ($rule.AccessControlType -eq 'Allow' -and $sid -ne $S.Sid -and $sid -ne 'S-1-5-18') {
                Exit-Install "$Path can still be read by $sid; only you should be able to read it."
            }
        }
    }

    # Writes a file through a temporary file beside it, protected before it takes
    # the file's place. An unchanged file isn't written again.
    function Write-FileAtomic([string]$Path, [string]$Content) {
        if ([IO.File]::Exists($Path)) {
            $current = [IO.File]::ReadAllBytes($Path)
            $next = $Utf8NoBom.GetBytes($Content)
            if ((Get-Sha256Hex $current) -eq (Get-Sha256Hex $next)) { return }
        }
        $tmp = "$Path.tmp.$(Get-RandomHex 4)"
        try {
            [IO.File]::WriteAllText($tmp, $Content, $Utf8NoBom)
            Protect-Path $tmp
            if ([IO.File]::Exists($Path)) {
                try {
                    [IO.File]::Replace($tmp, $Path, [NullString]::Value)
                } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
                    # Held open (Docker Desktop shares it with a running container):
                    # write it in place instead; it keeps its own permissions.
                    [IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
                }
            } else {
                [IO.File]::Move($tmp, $Path)
            }
        } finally {
            if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
        }
    }

    function Read-EnvLine([string]$Path) {
        $lines = New-Object 'System.Collections.Generic.List[string]'
        if (-not [IO.File]::Exists($Path)) { return , $lines }
        $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
        if ($text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
        if ($text.Length -gt 0) {
            foreach ($line in $text.Split("`n")) { $lines.Add($line.TrimEnd("`r")) }
        }
        return , $lines
    }

    # The value of KEY in an env file (empty when missing; the last one wins).
    function Get-EnvValue([string]$Path, [string]$Key) {
        $value = ''
        foreach ($line in (Read-EnvLine $Path)) {
            if ($line.StartsWith("$Key=", [StringComparison]::Ordinal)) { $value = $line.Substring($Key.Length + 1) }
        }
        return $value
    }

    # Set KEY in an env file: the first line with it is replaced and any others
    # dropped, or it is appended. The file ends up this user's only.
    function Write-EnvValue([string]$Path, [string]$Key, [string]$Value) {
        $out = New-Object 'System.Collections.Generic.List[string]'
        $done = $false
        foreach ($line in (Read-EnvLine $Path)) {
            if ($line.StartsWith("$Key=", [StringComparison]::Ordinal)) {
                if (-not $done) { $out.Add("$Key=$Value"); $done = $true }
                continue
            }
            $out.Add($line)
        }
        if (-not $done) { $out.Add("$Key=$Value") }
        Write-FileAtomic $Path (($out -join "`n") + "`n")
    }

    function Clear-EnvValue([string]$Path, [string]$Key) {
        if (-not [IO.File]::Exists($Path)) { return }
        $out = New-Object 'System.Collections.Generic.List[string]'
        foreach ($line in (Read-EnvLine $Path)) {
            if (-not $line.StartsWith("$Key=", [StringComparison]::Ordinal)) { $out.Add($line) }
        }
        $content = ''
        if ($out.Count -gt 0) { $content = ($out -join "`n") + "`n" }
        Write-FileAtomic $Path $content
    }

    # Download URL to DEST: fetched in full first, so a failed download never
    # leaves a half-written file. The bytes are kept as they are (LF endings).
    function Save-Download([string]$Url, [string]$Dest) {
        $bytes = $null
        for ($attempt = 1; $attempt -le 3 -and $null -eq $bytes; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60
                $bytes = $response.RawContentStream.ToArray()
            } catch {
                if ($attempt -eq 3) { Exit-Install "Could not download $Url. Check the ref and your network." }
                Start-Sleep -Seconds 2
            }
        }
        if ([IO.File]::Exists($Dest)) {
            if ((Get-Sha256Hex ([IO.File]::ReadAllBytes($Dest))) -eq (Get-Sha256Hex $bytes)) { return }
            $backup = "$Dest.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
            [IO.File]::Copy($Dest, $backup, $true)
            Write-InstallLog "Updated $([IO.Path]::GetFileName($Dest)); the previous copy is $backup"
        }
        $tmp = "$Dest.download.$(Get-RandomHex 4)"
        try {
            [IO.File]::WriteAllBytes($tmp, $bytes)
            if ([IO.File]::Exists($Dest)) {
                try {
                    [IO.File]::Replace($tmp, $Dest, [NullString]::Value)
                } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
                    # Held open (librechat.yaml is shared with the running Console):
                    # write it in place instead.
                    [IO.File]::WriteAllBytes($Dest, $bytes)
                }
            } else {
                [IO.File]::Move($tmp, $Dest)
            }
        } finally {
            if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
        }
    }

    # -------------------------------------------------------------------------
    # The install folder

    # What is at PATH, without following it: missing, file, dir, link (a symbolic
    # link or junction; Target is where it points, or empty when that can't be
    # read). Other reparse points, such as OneDrive folders, count as what they are.
    function Get-PathKind([string]$Path) {
        try {
            $attributes = [IO.File]::GetAttributes($Path)
        } catch {
            return @{ Kind = 'missing'; Target = '' }
        }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
            $item = $null
            try { $item = Get-Item -LiteralPath $Path -Force } catch { $item = $null }
            if ($null -eq $item) { return @{ Kind = 'link'; Target = '' } }
            $linkType = [string]$item.LinkType
            if ($linkType -eq 'SymbolicLink' -or $linkType -eq 'Junction') {
                $target = [string](@($item.Target) | Select-Object -First 1)
                foreach ($prefix in @('\??\', '\\?\')) {
                    if ($target.StartsWith($prefix) -and -not $target.StartsWith('\\?\UNC\')) { $target = $target.Substring($prefix.Length) }
                }
                if ($target -and -not [IO.Path]::IsPathRooted($target)) {
                    $target = [IO.Path]::Combine([IO.Path]::GetDirectoryName($Path), $target)
                }
                return @{ Kind = 'link'; Target = $target }
            }
        }
        if ($attributes -band [IO.FileAttributes]::Directory) { return @{ Kind = 'dir'; Target = '' } }
        return @{ Kind = 'file'; Target = '' }
    }

    # A folder's physical path, found the way creating it and then going into it
    # would, without creating anything: an existing component is followed (so
    # /tmp is /private/tmp on macOS; a junction goes to its target), a missing one
    # is taken as given, and ".." goes back up from wherever that leaves it.
    # Code 0 with the Path; 2 when the last component is a link and -FollowLast
    # isn't given, 3 when a component exists but isn't a folder, 4 when a link
    # can't be followed.
    function Resolve-PhysicalDir([string]$Path, [switch]$FollowLast, [int]$Depth = 0) {
        if ($Depth -gt 40) { return @{ Code = 4; Path = '' } }
        $root = [IO.Path]::GetPathRoot($Path)
        $parts = $Path.Substring($root.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
        $last = $parts.Length - 1
        while ($last -ge 0 -and ($parts[$last] -eq '' -or $parts[$last] -eq '.')) { $last-- }
        $cur = $root
        for ($i = 0; $i -lt $parts.Length; $i++) {
            $comp = $parts[$i]
            if ($comp -eq '' -or $comp -eq '.') { continue }
            if ($comp -eq '..') {
                $parent = [IO.Path]::GetDirectoryName($cur)
                if ($parent) { $cur = $parent }
                continue
            }
            $next = [IO.Path]::Combine($cur, $comp)
            $kind = Get-PathKind $next
            if ($kind.Kind -eq 'link') {
                if ($i -eq $last -and -not $FollowLast) { return @{ Code = 2; Path = '' } }
                if (-not $kind.Target) { return @{ Code = 4; Path = '' } }
                $resolved = Resolve-PhysicalDir -Path $kind.Target -FollowLast -Depth ($Depth + 1)
                if ($resolved.Code -ne 0) { return @{ Code = 4; Path = '' } }
                if ((Get-PathKind $resolved.Path).Kind -ne 'dir') { return @{ Code = 4; Path = '' } }
                $cur = $resolved.Path
            } elseif ($kind.Kind -eq 'file') {
                return @{ Code = 3; Path = '' }
            } else {
                $cur = $next
            }
        }
        return @{ Code = 0; Path = $cur }
    }

    function Test-SamePath([string]$A, [string]$B) {
        return [string]::Equals($A.TrimEnd('\', '/'), $B.TrimEnd('\', '/'), $PathComparison)
    }

    # Whether a folder is a stack from before the marker file existed: it has the
    # installer's own files, and its compose file runs the stack's gateway.
    function Test-LegacyStack([string]$Path) {
        $compose = [IO.Path]::Combine($Path, 'compose.yml')
        if (-not ([IO.File]::Exists($compose) -and [IO.File]::Exists([IO.Path]::Combine($Path, 'gateway.env')) -and [IO.File]::Exists([IO.Path]::Combine($Path, 'console.env')))) {
            return $false
        }
        return ([IO.File]::ReadAllText($compose).Contains('docker-gateway-entrypoint.sh'))
    }

    # Resolve -Dir to its physical path, and refuse any folder the installer
    # shouldn't own: a symbolic link or junction, the home folder, a drive's root,
    # a folder that contains the home folder, a network folder, or a folder with
    # other things in it. Every check runs on the resolved path; nothing is created.
    function Resolve-InstallDir([string]$Given) {
        $resolved = Resolve-PhysicalDir -Path $Given
        switch ($resolved.Code) {
            0 { }
            2 { Exit-Install "Refusing ${Given}: it is a symbolic link or junction. Give the folder itself." }
            3 { Exit-Install "Refusing ${Given}: part of that path exists and isn't a folder." }
            default { Exit-Install "Refusing ${Given}: a symbolic link or junction in that path can't be followed." }
        }
        $resolvedDir = $resolved.Path
        $homeResolved = Resolve-PhysicalDir -Path $HOME -FollowLast
        if ($homeResolved.Code -ne 0 -or -not [IO.Directory]::Exists($homeResolved.Path)) { Exit-Install "Your home folder ($HOME) can't be read." }
        $homeDir = $homeResolved.Path
        $root = [IO.Path]::GetPathRoot($resolvedDir)
        $homeUnder = $homeDir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        $dirUnder = $resolvedDir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if ((Test-SamePath $resolvedDir $root) -or (Test-SamePath $resolvedDir $homeDir) -or $homeUnder.StartsWith($dirUnder, $PathComparison)) {
            Exit-Install "Refusing to install into $Given ($resolvedDir): that is your home folder, a drive's root, or a folder that contains your home folder. Choose a folder of its own, such as `$HOME$([IO.Path]::DirectorySeparatorChar)$DefaultDirName."
        }
        if ($OnWindows) {
            if ($resolvedDir.StartsWith('\\')) {
                Exit-Install "Refusing ${Given}: it is a network folder, which Docker Desktop can't use for the stack's files. Choose a folder on this computer."
            }
            $driveType = ''
            try { $driveType = [string](New-Object System.IO.DriveInfo $root).DriveType } catch { $driveType = '' }
            if ($driveType -eq 'Network') {
                Exit-Install "Refusing ${Given}: $root is a network drive, which Docker Desktop can't use for the stack's files. Choose a folder on this computer."
            }
        }
        if ([IO.Directory]::Exists($resolvedDir) -and -not [IO.File]::Exists([IO.Path]::Combine($resolvedDir, $Marker)) -and -not (Test-LegacyStack $resolvedDir)) {
            if (@(Get-ChildItem -LiteralPath $resolvedDir -Force | Select-Object -First 1).Count -gt 0) {
                Exit-Install "$Given isn't empty and isn't a MindStone stack install (no $Marker file), so it was left alone. Choose a new or empty folder with -Dir."
            }
        }
        return @{ Dir = $resolvedDir; Home = $homeDir }
    }

    # Create the install folder, and check it is where Resolve-InstallDir resolved it.
    function Initialize-InstallDir {
        [void][IO.Directory]::CreateDirectory($S.InstallDir)
        $again = Resolve-PhysicalDir -Path $S.InstallDir
        if ($again.Code -ne 0 -or -not (Test-SamePath $again.Path $S.InstallDir)) {
            Exit-Install "$($S.InstallDir) changed while installing (a symbolic link or junction?); stopping."
        }
    }

    # The commands that delete what the installer created, and nothing else.
    function Show-DeleteCommand([string]$Project, [bool]$MongoInVolume) {
        $volumes = "${Project}_gateway-runtime ${Project}_pi-agent ${Project}_pi-sessions ${Project}_console-data"
        if ($MongoInVolume) { $volumes += " ${Project}_$MongoVolume" }
        $dirQ = Format-Quoted $S.InstallDir
        $files = (($CreatedFiles | ForEach-Object { Format-Quoted $_ }) -join ', ')
        Write-Host @"
To delete the stack's data as well, which can't be undone:
  docker volume rm $volumes
  docker volume rm ${Project}_ollama-models    # only if you used -WithOllama
  Set-Location -LiteralPath $dirQ
  Remove-Item -LiteralPath 'data' -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $files -Force -ErrorAction SilentlyContinue
  Get-ChildItem -File -Force | Where-Object { `$_.Name -like 'compose.yml.bak.*' -or `$_.Name -like 'librechat.yaml.bak.*' -or `$_.Name -like 'console.env.example.bak.*' } | Remove-Item -Force
  Set-Location ..; [IO.Directory]::Delete($dirQ)
(Only the files the installer made are deleted; the last command then fails, and
leaves the folder, if you added files of your own such as compose.override.yml.)
"@
    }

    # -------------------------------------------------------------------------
    # The admin account

    # An email the Console accepts (its zod check), without quotes: the local part
    # is letters, digits and _ + - ., with no dot first, last or doubled.
    function Test-AdminEmail([string]$Email) {
        return ($Email -cmatch '\A[A-Za-z0-9_+-]([A-Za-z0-9_+.-]*[A-Za-z0-9_+-])?@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}\z' -and -not $Email.Contains('..'))
    }

    function Test-AdminName([string]$Name) {
        return ($Name.Length -ge 3 -and $Name.Length -le 80 -and $Name -notmatch '[\x00-\x1F\x7F]')
    }

    # The Console's username from an email's local part: letters, digits, . and _
    # (the Console refuses "--", "/", "=" and quotes). Too short: a longer one.
    function Get-AdminUsername([string]$Email) {
        $local = $Email.Split('@')[0].ToLowerInvariant()
        $name = [regex]::Replace($local, '[^a-z0-9._]', '_')
        if ($name.Length -gt 60) { $name = $name.Substring(0, 60) }
        if ($name.Length -lt 2) { $name = Get-FallbackUsername $name }
        return $name
    }

    function Get-FallbackUsername([string]$Name) {
        # The name (or "admin") with an underscore and 4 random characters.
        if (-not $Name) { $Name = 'admin' }
        return "${Name}_$(Get-RandomHex 2)"
    }

    # A value from the Console's database, read in the mongodb container (the
    # gateway isn't on its network). EXPRESSION is a mongosh expression; the values
    # put in it are checked above to hold no quotes. Retries while MongoDB starts.
    function Get-MongoValue([string]$Expression) {
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $result = Invoke-Compose -Capture -ArgumentList @('exec', '-T', '-e', 'HOME=/tmp', 'mongodb', 'mongosh', '--quiet', '--norc', 'MindStoneConsole', '--eval', "print('OK:' + ($Expression))")
            $found = $null
            foreach ($line in $result.Output.Split("`n")) {
                $line = $line.TrimEnd("`r")
                if ($line.StartsWith('OK:')) { $found = $line.Substring(3) }
            }
            if ($null -ne $found) { return $found }
            Start-Sleep -Seconds 3
        }
        Exit-Install "Could not read the Console's accounts in MongoDB. The stack is running; re-run this command to try again."
    }

    # The role of the account with this email, or "none".
    function Get-AccountRole([string]$Email) {
        return Get-MongoValue "(db.users.findOne({ email: '$Email' }) || {}).role || 'none'"
    }

    # The command that makes the account with this email a Console admin (printed, not run).
    function Get-PromoteCommand([string]$Email) {
        $eval = "db.users.updateOne({ email: ''$Email'' }, { `$set: { role: ''ADMIN'' } })"
        return "Set-Location -LiteralPath $(Format-Quoted $S.InstallDir); docker compose exec -T -e HOME=/tmp mongodb mongosh --quiet MindStoneConsole --eval '$eval'"
    }

    # The HTTP status of a sign-in to the Console (0 when it didn't answer). The
    # body is sent as UTF-8 bytes: Windows PowerShell 5.1 would send a string body
    # as ISO-8859-1. Nothing of the request or response is printed.
    function Test-ConsoleSignIn([string]$Url, [string]$Email, [string]$Secret) {
        $body = $Utf8NoBom.GetBytes((@{ email = $Email; password = $Secret } | ConvertTo-Json -Compress))
        try {
            $response = Invoke-WebRequest -Uri $Url -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 30
            return [int]$response.StatusCode
        } catch {
            $failed = $_.Exception
            if ($null -ne $failed -and ($failed.PSObject.Properties.Name -contains 'Response') -and $null -ne $failed.Response) {
                return [int]$failed.Response.StatusCode
            }
            return 0
        } finally {
            # $Error can still hold the request's parameters: empty the bytes themselves.
            if ($null -ne $body) { [Array]::Clear($body, 0, $body.Length) }
            $body = $null
        }
    }

    # Signs in to the Console once, as the admin will, so a password that didn't
    # arrive as typed is found now. Only 404 and 422 mean the Console refused the
    # email and password: that stops the install (no marker, so a re-run reports
    # the account as existing). No answer or a server error is tried once more.
    # Anything else (a timeout, 403, 429, 5xx) means sign-in couldn't be checked:
    # a warning, and the install goes on. Returns 'ok' or 'unchecked'.
    function Confirm-AdminSignIn([string]$Url, [string]$Email, [string]$Secret, [string]$OpenUrl, [string]$ResetCommand) {
        $status = Test-ConsoleSignIn $Url $Email $Secret
        if ($status -eq 0 -or $status -ge 500) {
            Start-Sleep -Seconds 5
            $status = Test-ConsoleSignIn $Url $Email $Secret
        }
        if ($status -eq 200) { return 'ok' }
        if ($status -eq 404 -or $status -eq 422) {
            Exit-Install "The admin account $Email was created with role ADMIN, but the Console refused its password when the installer signed in (HTTP $status), so the password didn't reach the Console as it should. Set a new one, then sign in at ${OpenUrl}: $ResetCommand"
        }
        $what = "HTTP $status"
        if ($status -eq 0) { $what = 'no answer' }
        Write-InstallWarning "The admin account $Email was created with role ADMIN, but signing in to check its password couldn't be done ($what). Sign in at $OpenUrl yourself; if the password is refused, set a new one with: $ResetCommand"
        return 'unchecked'
    }

    # Whether this session can ask questions: a console that isn't redirected, and
    # PowerShell not started with -NonInteractive.
    function Test-Interactive {
        if (-not [Environment]::UserInteractive) { return $false }
        try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
        foreach ($arg in [Environment]::GetCommandLineArgs()) {
            if ($arg -match '^[-/]noni') { return $false }
        }
        return $true
    }

    # -------------------------------------------------------------------------
    # Ports

    # Whether something answers on 127.0.0.1:PORT.
    function Test-PortInUse([int]$Port) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
            if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }
            try { $client.EndConnect($pending); return $true } catch { return $false }
        } finally {
            $client.Close()
        }
    }

    # Whether 127.0.0.1:PORT can be listened on. On Windows a port can be free and
    # still reserved (Hyper-V and WinNAT exclude ranges), and Docker then can't use it.
    function Test-PortBindable([int]$Port) {
        $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), $Port
        try {
            $listener.Start()
            return $true
        } catch {
            return $false
        } finally {
            try { $listener.Stop() } catch { Write-Verbose 'The listener was not started.' }
        }
    }

    # Whether this stack's own containers publish 127.0.0.1:PORT (a re-run).
    function Test-PortOwnedByStack([int]$Port) {
        $result = Invoke-Native -FilePath $S.Docker -Capture -ArgumentList @('ps', '--filter', "label=com.docker.compose.project=$($S.Project)", '--format', '{{.Ports}}')
        return ($result.ExitCode -eq 0 -and $result.Output.Contains("127.0.0.1:$Port->"))
    }

    function Test-TruthyEnv([string]$Name) {
        $value = [Environment]::GetEnvironmentVariable($Name)
        return ($null -ne $value -and $value -match '^(1|true|yes|on)$')
    }

    # =========================================================================

    try {
        if ($EndOfScript -ne 'yes') {
            Exit-Install 'The installer did not download in full, so nothing was run. Run the command again.'
        }
        if ($null -ne $Unexpected -and $Unexpected.Count -gt 0) {
            $first = [string]$Unexpected[0]
            $hint = ''
            if ($first -cmatch '\A--?([a-z][a-z-]*)\z') {
                # --with-ollama is -WithOllama here.
                $words = $Matches[1].Split('-') | Where-Object { $_ } | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
                $hint = " PowerShell options have one dash and no inner dashes: -$($words -join '')."
            }
            Exit-Install "Unexpected argument: $first.$hint Options must be named, as in -Dir <path> -AdminEmail <email> -WithOllama (see -Help)."
        }
        if ($Help) {
            Show-Usage
            return
        }

        # TLS 1.2 for the downloads (Windows PowerShell 5.1 can default to older).
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {
            Write-Verbose 'TLS 1.2 is already the default here.'
        }

        # The options: a parameter, else its environment variable (irm | iex takes no parameters).
        $uninstallMode = $Uninstall.IsPresent -or (Test-TruthyEnv 'MINDSTONE_UNINSTALL')
        if (-not $AdminEmail -and $env:MINDSTONE_ADMIN_EMAIL) { $AdminEmail = $env:MINDSTONE_ADMIN_EMAIL }
        if (-not $AdminName -and $env:MINDSTONE_ADMIN_NAME) { $AdminName = $env:MINDSTONE_ADMIN_NAME }
        $ollamaMode = ''
        $withStack = $WithOllama.IsPresent
        $withHost = $WithoutOllama.IsPresent
        if (-not $withStack -and -not $withHost) {
            $withStack = Test-TruthyEnv 'MINDSTONE_WITH_OLLAMA'
            $withHost = Test-TruthyEnv 'MINDSTONE_WITHOUT_OLLAMA'
        }
        if ($withStack -and $withHost) { Exit-Install 'Choose one of -WithOllama and -WithoutOllama.' }
        if ($withStack) { $ollamaMode = 'stack' }
        if ($withHost) { $ollamaMode = 'host' }

        $given = $Dir
        if (-not $given) { $given = $env:MINDSTONE_DIR }
        if (-not $given) { $given = [IO.Path]::Combine($HOME, $DefaultDirName) }
        # A literal ~ means the home folder.
        if ($given -eq '~') {
            $given = $HOME
        } elseif ($given.StartsWith('~/') -or $given.StartsWith('~\')) {
            $given = [IO.Path]::Combine($HOME, $given.Substring(2))
        }
        if (-not [IO.Path]::IsPathRooted($given)) {
            $given = [IO.Path]::Combine((Get-Location -PSProvider FileSystem).ProviderPath, $given)
        } elseif ($OnWindows -and $given -notmatch '^([A-Za-z]:[\\/]|\\\\)') {
            # \folder or C:folder: relative to a drive, so made whole first.
            $given = [IO.Path]::GetFullPath($given)
        }
        $checked = Resolve-InstallDir $given
        $S.InstallDir = $checked.Dir
        $S.EnvFile = [IO.Path]::Combine($S.InstallDir, '.env')
        $defaultDir = [IO.Path]::Combine($checked.Home, $DefaultDirName)
        # How to name this install again in the commands printed at the end.
        $dirArg = ''
        if (-not (Test-SamePath $S.InstallDir $defaultDir)) { $dirArg = " -Dir $(Format-Quoted $S.InstallDir)" }
        $dirQ = Format-Quoted $S.InstallDir
        $runCommand = "& ([scriptblock]::Create((irm $InstallUrl)))"

        # ---------------------------------------------------------------------
        # Uninstall: stop and remove the containers. Volumes and files stay.
        if ($uninstallMode) {
            if (-not [IO.File]::Exists([IO.Path]::Combine($S.InstallDir, 'compose.yml'))) {
                Exit-Install "No MindStone stack found in $($S.InstallDir) (no compose.yml)."
            }
            $dockerCommand = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $dockerCommand) { Exit-Install 'docker is not installed.' }
            $S.Docker = $dockerCommand.Path
            $S.Project = Get-EnvValue $S.EnvFile 'COMPOSE_PROJECT_NAME'
            if (-not $S.Project) { $S.Project = 'mindstone-stack' }
            $mongoInVolume = (Get-EnvValue $S.EnvFile 'MINDSTONE_MONGO_DATA') -eq $MongoVolume
            Write-InstallLog "Stopping the MindStone stack (project $($S.Project))..."
            $code = Invoke-Compose -ArgumentList @('--profile', 'ollama', 'down', '--remove-orphans')
            if ($code -ne 0) { Exit-Install "docker compose down failed (exit code $code)." }
            $dataFolder = "$($S.InstallDir)$([IO.Path]::DirectorySeparatorChar)data"
            $kept = "the Docker volumes $($S.Project)_*, $dataFolder`n(the Console's database, uploads and logs)"
            if ($mongoInVolume) {
                $kept = "the Docker volumes $($S.Project)_* (the Console's database is in`n$($S.Project)_$MongoVolume), $dataFolder (its uploads and logs)"
            }
            Write-Host @"

The MindStone stack is stopped and its containers are removed.
Your data is kept: $kept
and the secrets in $($S.InstallDir).

Start it again:  Set-Location -LiteralPath $dirQ; docker compose up -d
"@
            Show-DeleteCommand $S.Project $mongoInVolume
            return
        }

        # ---------------------------------------------------------------------
        # Requirements
        if ($OnWindows) {
            $principal = New-Object System.Security.Principal.WindowsPrincipal ([System.Security.Principal.WindowsIdentity]::GetCurrent())
            if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
                Write-InstallWarning "Running as Administrator isn't needed: the stack is installed for $env:USERNAME, in $($S.InstallDir). If this window was opened as another account, stop and run it from your own."
            }
        } else {
            $idResult = Invoke-Native -FilePath 'id' -ArgumentList @('-u') -Capture
            if ($idResult.Output.Trim() -eq '0') {
                Write-InstallWarning 'Running as root: the stack would be installed for root (in its home folder, with its ids). Run it as your own user instead.'
            }
        }
        $dockerCommand = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $dockerCommand) {
            Exit-Install 'Docker is required: install Docker Desktop (https://docs.docker.com/desktop/), start it, then run this again.'
        }
        $S.Docker = $dockerCommand.Path
        $info = Invoke-Native -FilePath $S.Docker -ArgumentList @('info', '--format', '{{.OSType}}') -Capture
        if ($info.ExitCode -ne 0) {
            Exit-Install "Docker isn't reachable (docker info failed). Start Docker Desktop and wait until it says it is running, then run this again. If it is running, your account may need to be in the docker-users group (then sign out and in again)."
        }
        $osType = $info.Output.Trim()
        if ($osType -ne 'linux') {
            Exit-Install "Docker is running $osType containers; the stack needs Linux containers. In Docker Desktop, choose Switch to Linux containers (the Docker icon's menu), then run this again."
        }
        $composeVersion = (Invoke-Native -FilePath $S.Docker -ArgumentList @('compose', 'version', '--short') -Capture).Output.Trim()
        $composeMajor = 0
        if ($composeVersion -match '^v?(\d+)\.') { $composeMajor = [int]$Matches[1] }
        if ($composeMajor -lt 2) {
            if (-not $composeVersion) { $composeVersion = 'none' }
            Exit-Install "Docker Compose v2 or newer is required ('docker compose version'); found: $composeVersion."
        }

        # ---------------------------------------------------------------------
        # Settings: a parameter, else the stack's own environment variable, else
        # .env, else the default. No other variable of this session is read.
        function Get-Setting([string]$Key, [string]$Value, [string]$EnvName, [string]$Default) {
            if (-not $Value -and $EnvName) { $Value = [Environment]::GetEnvironmentVariable($EnvName) }
            if (-not $Value) { $Value = Get-EnvValue $S.EnvFile $Key }
            if (-not $Value) { $Value = $Default }
            return $Value
        }

        $agentGitRef = Get-Setting 'MINDSTONE_REF' $Ref 'MINDSTONE_REF' 'main'
        $consoleGitRef = Get-Setting 'CONSOLE_REF' $ConsoleRef 'CONSOLE_REF' 'main'
        $consolePort = Get-Setting 'CONSOLE_PORT' '' 'CONSOLE_PORT' '3080'
        $gatewayPort = Get-Setting 'MINDSTONE_GATEWAY_PORT' '' 'MINDSTONE_GATEWAY_PORT' '19789'
        $S.Project = Get-Setting 'COMPOSE_PROJECT_NAME' '' 'MINDSTONE_PROJECT' 'mindstone-stack'
        $profiles = Get-EnvValue $S.EnvFile 'COMPOSE_PROFILES'
        $gatewayOllamaUrl = ''
        if ($ollamaMode -eq 'stack') { $profiles = 'ollama'; $gatewayOllamaUrl = $StackOllamaUrl }
        if ($ollamaMode -eq 'host') { $profiles = ''; $gatewayOllamaUrl = $HostOllamaUrl }
        if ($OllamaUrl) { $gatewayOllamaUrl = $OllamaUrl }
        $previousOllamaUrl = Get-EnvValue $S.EnvFile 'OLLAMA_BASE_URL'
        $gatewayOllamaUrl = Get-Setting 'OLLAMA_BASE_URL' $gatewayOllamaUrl 'MINDSTONE_OLLAMA_BASE_URL' $HostOllamaUrl

        foreach ($port in @($consolePort, $gatewayPort)) {
            if ($port -cnotmatch '\A[0-9]{1,5}\z' -or [int]$port -lt 1 -or [int]$port -gt 65535) { Exit-Install "Not a port number: $port" }
        }
        if ($consolePort -eq $gatewayPort) { Exit-Install 'CONSOLE_PORT and MINDSTONE_GATEWAY_PORT must differ.' }
        if ($S.Project -cnotmatch '\A[a-z0-9][a-z0-9_-]*\z') { Exit-Install 'MINDSTONE_PROJECT must be lowercase letters, digits, - and _.' }
        foreach ($gitRef in @($agentGitRef, $consoleGitRef)) {
            if ($gitRef -cnotmatch '\A[A-Za-z0-9._/-]+\z') { Exit-Install "Not a git ref: $gitRef" }
        }
        # The address the gateway container uses for Ollama.
        if ($gatewayOllamaUrl -cnotmatch '\Ahttps?://[^/\s]+(/\S*)?\z') { Exit-Install "Not an http(s) URL for Ollama: $gatewayOllamaUrl" }
        $ollamaHost = $gatewayOllamaUrl.Substring($gatewayOllamaUrl.IndexOf('://') + 3).Split('/')[0]
        if ($ollamaHost.Contains(':')) { $ollamaHost = $ollamaHost.Substring(0, $ollamaHost.LastIndexOf(':')) }
        if ($ollamaHost -eq 'localhost' -or $ollamaHost.StartsWith('127.') -or $ollamaHost -eq '0.0.0.0' -or $ollamaHost -eq '[::1]' -or $ollamaHost -eq '[::]') {
            Write-InstallWarning "Ollama at ${gatewayOllamaUrl}: inside the gateway container, $ollamaHost is the container itself, not this machine. Use $HostOllamaUrl for Ollama on this machine."
        }
        if (-not $gatewayOllamaUrl.TrimEnd('/').EndsWith('/v1')) {
            Write-InstallWarning "Ollama at ${gatewayOllamaUrl}: the address should end in /v1 (Ollama's OpenAI-compatible API), as in $HostOllamaUrl."
        }

        # ---------------------------------------------------------------------
        # The admin account's details, asked for or checked before the long build.
        $adminMarker = [IO.Path]::Combine($S.InstallDir, '.admin-created')
        $adminMode = 'none'
        $adminUsername = ''
        $adminSecret = ''
        if ([IO.File]::Exists($adminMarker)) {
            $adminMode = 'done'
        } elseif ($AdminEmail) {
            if (-not (Test-AdminEmail $AdminEmail)) {
                Exit-Install '-AdminEmail is not an email address the Console accepts (letters, digits and _ + - . before the @, no dot first, last or doubled).'
            }
            if (-not $AdminName) { $AdminName = 'Admin' }
            if (-not (Test-AdminName $AdminName)) { Exit-Install '-AdminName must be 3 to 80 characters.' }
            $adminMode = 'generated'
        } elseif (Test-Interactive) {
            Write-Host ''
            Write-Host 'The MindStone Console admin account.'
            while ($true) {
                $AdminEmail = Read-Host -Prompt 'Email'
                if (Test-AdminEmail $AdminEmail) { break }
                Write-Host 'That is not an email address.'
            }
            while ($true) {
                $AdminName = Read-Host -Prompt 'Name [Admin]'
                if (-not $AdminName) { $AdminName = 'Admin' }
                if (Test-AdminName $AdminName) { break }
                Write-Host 'The name must be 3 to 80 characters.'
            }
            while ($true) {
                $first = Read-Host -Prompt 'Password (8 to 128 characters, not shown)' -AsSecureString
                $second = Read-Host -Prompt 'Password again' -AsSecureString
                $adminSecret = (New-Object System.Net.NetworkCredential -ArgumentList '', $first).Password
                $again = (New-Object System.Net.NetworkCredential -ArgumentList '', $second).Password
                $first.Dispose()
                $second.Dispose()
                $matched = [string]::Equals($adminSecret, $again, [StringComparison]::Ordinal)
                $again = $null
                if ($adminSecret.Length -lt 8 -or $adminSecret.Length -gt 128) {
                    Write-Host 'It must be 8 to 128 characters.'
                } elseif (-not $matched) {
                    Write-Host 'They do not match.'
                } else {
                    break
                }
            }
            $adminMode = 'asked'
        }
        if ($adminMode -eq 'generated' -or $adminMode -eq 'asked') {
            $AdminEmail = $AdminEmail.ToLowerInvariant()
            $adminUsername = Get-AdminUsername $AdminEmail
        }

        # ---------------------------------------------------------------------
        # The install folder and its settings
        Write-InstallLog "Install dir:        $($S.InstallDir)"
        Write-InstallLog "MindStone-Agent:    $agentGitRef"
        Write-InstallLog "MindStone Console:  $consoleGitRef"
        Write-InstallLog "Console port:       127.0.0.1:$consolePort   gateway port: 127.0.0.1:$gatewayPort"
        Write-InstallLog "Compose project:    $($S.Project)"

        # Both ports must be free, or held by this stack already (a re-run).
        foreach ($entry in @(@('CONSOLE_PORT', $consolePort), @('MINDSTONE_GATEWAY_PORT', $gatewayPort))) {
            $name = $entry[0]
            $port = [int]$entry[1]
            if ((Test-PortInUse $port) -and -not (Test-PortOwnedByStack $port)) {
                Exit-Install "Port $port on 127.0.0.1 is already in use ($name). Stop what uses it (a native MindStone gateway uses 19789), or choose another port: `$env:$name = '<port>' before running the installer."
            }
            if (-not (Test-PortInUse $port) -and -not (Test-PortBindable $port)) {
                Exit-Install "Port $port on 127.0.0.1 can't be used ($name), though nothing answers on it: Windows may reserve it (see: netsh interface ipv4 show excludedportrange protocol=tcp). Choose another port: `$env:$name = '<port>' before running the installer."
            }
        }

        Initialize-InstallDir
        Protect-Path $S.InstallDir -Directory
        $markerPath = [IO.Path]::Combine($S.InstallDir, $Marker)
        if (-not [IO.File]::Exists($markerPath)) {
            [IO.File]::WriteAllText($markerPath, "This folder is a MindStone stack install (install-stack.ps1). Delete it only with the commands -Uninstall prints.`n", $Utf8NoBom)
        }
        if (-not [IO.File]::Exists($S.EnvFile)) { [IO.File]::WriteAllText($S.EnvFile, '', $Utf8NoBom) }
        Protect-Path $S.EnvFile

        # Compose's own settings (no secrets): read by every `docker compose` in the install dir.
        Write-EnvValue $S.EnvFile 'COMPOSE_PROJECT_NAME' $S.Project
        Write-EnvValue $S.EnvFile 'MINDSTONE_REF' $agentGitRef
        Write-EnvValue $S.EnvFile 'CONSOLE_REF' $consoleGitRef
        Write-EnvValue $S.EnvFile 'CONSOLE_PORT' $consolePort
        Write-EnvValue $S.EnvFile 'MINDSTONE_GATEWAY_PORT' $gatewayPort
        Write-EnvValue $S.EnvFile 'OLLAMA_BASE_URL' $gatewayOllamaUrl
        $uid = '1000'
        $gid = '1000'
        if (-not $OnWindows) {
            $uid = (Invoke-Native -FilePath 'id' -ArgumentList @('-u') -Capture).Output.Trim()
            $gid = (Invoke-Native -FilePath 'id' -ArgumentList @('-g') -Capture).Output.Trim()
        }
        Write-EnvValue $S.EnvFile 'UID' $uid
        Write-EnvValue $S.EnvFile 'GID' $gid
        if ($profiles) {
            Write-EnvValue $S.EnvFile 'COMPOSE_PROFILES' $profiles
        } else {
            Clear-EnvValue $S.EnvFile 'COMPOSE_PROFILES'
        }
        # Where the Console's database lives is chosen once, and recorded in .env. A
        # data\mongo folder with anything in it (an install made by install-stack.sh,
        # even one whose .env is gone) keeps it; otherwise the named volume.
        if (-not (Get-EnvValue $S.EnvFile 'MINDSTONE_MONGO_DATA')) {
            $mongoFolder = [IO.Path]::Combine([IO.Path]::Combine($S.InstallDir, 'data'), 'mongo')
            $mongoFolderUsed = [IO.Directory]::Exists($mongoFolder) -and @(Get-ChildItem -LiteralPath $mongoFolder -Force | Select-Object -First 1).Count -gt 0
            if (-not $mongoFolderUsed) {
                Write-EnvValue $S.EnvFile 'MINDSTONE_MONGO_DATA' $MongoVolume
                Write-EnvValue $S.EnvFile 'MINDSTONE_MONGO_USER' $MongoUser
            } else {
                # Recorded too, so the choice holds even if the folder is emptied later.
                Write-EnvValue $S.EnvFile 'MINDSTONE_MONGO_DATA' './data/mongo'
                Write-InstallLog "The Console's database stays in $mongoFolder (an earlier install)."
            }
        }
        $mongoInVolume = (Get-EnvValue $S.EnvFile 'MINDSTONE_MONGO_DATA') -eq $MongoVolume

        # ---------------------------------------------------------------------
        # Files, pinned to the refs
        Write-InstallLog "Downloading the stack's files..."
        Save-Download "$RawMsa/$agentGitRef/deploy/docker/compose.yml" ([IO.Path]::Combine($S.InstallDir, 'compose.yml'))
        Save-Download "$RawConsole/$consoleGitRef/mindstone/librechat.yaml" ([IO.Path]::Combine($S.InstallDir, 'librechat.yaml'))
        Save-Download "$RawConsole/$consoleGitRef/mindstone/.env.example" ([IO.Path]::Combine($S.InstallDir, 'console.env.example'))
        if ($mongoInVolume -and -not ([IO.File]::ReadAllText([IO.Path]::Combine($S.InstallDir, 'compose.yml')).Contains('MINDSTONE_MONGO_DATA'))) {
            Exit-Install "The compose.yml of MindStone-Agent $agentGitRef predates install-stack.ps1 (it has no MINDSTONE_MONGO_DATA). Install a newer ref with -Ref."
        }
        $dataDir = [IO.Path]::Combine($S.InstallDir, 'data')
        foreach ($sub in @('uploads', 'logs')) { [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($dataDir, $sub)) }
        if (-not $mongoInVolume) { [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($dataDir, 'mongo')) }
        if ([IO.File]::Exists([IO.Path]::Combine($S.InstallDir, 'compose.override.yml'))) {
            Write-InstallLog 'Using your compose.override.yml.'
        }

        # ---------------------------------------------------------------------
        # Secrets: generated once, into files only this user can read, never
        # printed. A re-run keeps them.
        $gatewayEnv = [IO.Path]::Combine($S.InstallDir, 'gateway.env')
        $consoleEnv = [IO.Path]::Combine($S.InstallDir, 'console.env')
        $createdConsoleEnv = $false
        if (-not [IO.File]::Exists($consoleEnv)) {
            $example = [IO.File]::ReadAllText([IO.Path]::Combine($S.InstallDir, 'console.env.example')).Replace("`r`n", "`n")
            Write-FileAtomic $consoleEnv $example
            $createdConsoleEnv = $true
        }
        if (-not [IO.File]::Exists($gatewayEnv)) { Write-FileAtomic $gatewayEnv '' }
        Protect-Path $consoleEnv
        Protect-Path $gatewayEnv

        # A new random value, only when KEY has none.
        foreach ($fill in @(
                @($consoleEnv, 'CREDS_KEY', 32),
                @($consoleEnv, 'CREDS_IV', 16),
                @($consoleEnv, 'JWT_SECRET', 32),
                @($consoleEnv, 'JWT_REFRESH_SECRET', 32),
                @($consoleEnv, 'MINDSTONE_ADMIN_TOKEN', 32),
                @($gatewayEnv, 'MINDSTONE_AGENT_GATEWAY_TOKEN', 32))) {
            if (-not (Get-EnvValue $fill[0] $fill[1])) {
                Write-EnvValue $fill[0] $fill[1] (Get-RandomHex $fill[2])
            }
        }

        # The gateway token is the same in both files: gateway.env holds it.
        $gatewayToken = Get-EnvValue $gatewayEnv 'MINDSTONE_AGENT_GATEWAY_TOKEN'
        if ((Get-EnvValue $consoleEnv 'MINDSTONE_GATEWAY_TOKEN') -cne $gatewayToken) {
            Write-EnvValue $consoleEnv 'MINDSTONE_GATEWAY_TOKEN' $gatewayToken
            if (-not $createdConsoleEnv) { Write-InstallLog 'console.env: the gateway token was brought in line with gateway.env.' }
        }
        $gatewayToken = $null
        # The admin credential's plaintext lives only in console.env; the gateway gets its sha256.
        Write-EnvValue $gatewayEnv 'MINDSTONE_ADMIN_TOKEN_SHA256' (Get-Sha256Hex ($Utf8NoBom.GetBytes((Get-EnvValue $consoleEnv 'MINDSTONE_ADMIN_TOKEN'))))
        # The Console reaches the gateway on the stack's network (compose.yml sets it too).
        Write-EnvValue $consoleEnv 'MINDSTONE_GATEWAY_URL' 'http://gateway:19789/v1'
        # Sign-up from the page stays off: the admin is created below.
        if (-not (Get-EnvValue $consoleEnv 'ALLOW_REGISTRATION')) {
            Write-EnvValue $consoleEnv 'ALLOW_REGISTRATION' 'false'
        }

        $secretCount = @((Read-EnvLine $consoleEnv) | Where-Object { $_ -cmatch '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' }).Count
        if ($secretCount -ne 6) { Exit-Install "console.env should have 6 secrets set; it has $secretCount." }
        Write-InstallLog "Secrets are in $consoleEnv and $gatewayEnv (readable by you only)."

        # ---------------------------------------------------------------------
        # Build and start
        Write-InstallLog 'Building and starting the stack. The first build takes several minutes...'
        if (-not $profiles) {
            # Back from -WithOllama: the in-stack Ollama stops; its models volume stays.
            [void](Invoke-Compose -Capture -ArgumentList @('--profile', 'ollama', 'rm', '--stop', '--force', 'ollama'))
        }
        $code = Invoke-Compose -ArgumentList @('up', '-d', '--build', '--remove-orphans')
        if ($code -ne 0) { Exit-Install "docker compose up failed (exit code $code). See the output above; then run this again." }

        function Wait-ForService([string]$Name, [string]$Url, [int]$Seconds) {
            $waited = 0
            while ($true) {
                try {
                    [void](Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5)
                    break
                } catch {
                    if ($waited -ge $Seconds) {
                        [void](Invoke-Compose -ArgumentList @('ps'))
                        Exit-Install "$Name did not answer at $Url within ${Seconds}s. See: Set-Location -LiteralPath $dirQ; docker compose logs $Name"
                    }
                    Start-Sleep -Seconds 3
                    $waited += 3
                }
            }
            Write-InstallLog "$Name is up."
        }
        Wait-ForService 'gateway' "http://127.0.0.1:$gatewayPort/health" 180
        Wait-ForService 'console' "http://127.0.0.1:$consolePort/" 300

        # ---------------------------------------------------------------------
        # The Console's admin account
        $passwordFile = [IO.Path]::Combine($S.InstallDir, 'admin-password')
        $adminStatus = $adminMode
        $existingRole = ''
        if ($adminMode -eq 'done') {
            $firstLine = [string]((Read-EnvLine $adminMarker) | Select-Object -First 1)
            Write-InstallLog "The admin account was set up by an earlier run: $firstLine."
        } elseif ($adminMode -eq 'generated' -or $adminMode -eq 'asked') {
            $existingRole = Get-AccountRole $AdminEmail
            if ($existingRole -ne 'none') {
                # The account exists already: it keeps its own password and role. No
                # marker, so a later run with another -AdminEmail still creates one.
                $adminStatus = 'exists'
            } else {
                # The Console makes only its first account an admin: count them first.
                $otherAccounts = Get-MongoValue 'db.users.countDocuments({})'
                # A username another account has gets a longer one.
                $tries = 0
                while ((Get-MongoValue "db.users.countDocuments({ username: '$adminUsername' })") -ne '0') {
                    $tries++
                    if ($tries -gt 5) { Exit-Install "Could not find a free username for $AdminEmail. The stack is running; re-run this command to try again." }
                    $adminUsername = Get-FallbackUsername (Get-AdminUsername $AdminEmail)
                }
                if ($adminMode -eq 'generated') {
                    if (-not [IO.File]::Exists($passwordFile) -or ([IO.FileInfo]$passwordFile).Length -eq 0) {
                        Write-FileAtomic $passwordFile ((Get-RandomHex 18) + "`n")
                    }
                    Protect-Path $passwordFile
                    $adminSecret = [string]((Read-EnvLine $passwordFile) | Select-Object -First 1)
                }
                $created = Invoke-Compose -Capture -InputText ($adminSecret + "`n") -ArgumentList @('exec', '-T', 'console', 'npm', 'run', '--silent', 'create-user', '--', $AdminEmail, $AdminName, $adminUsername, '--email-verified=true')
                $output = $created.Output + "`n" + $created.Errors
                if ($created.ExitCode -ne 0 -or -not $output.Contains('User created successfully')) {
                    # Only the tool's own error lines, which never contain the password.
                    $output.Split("`n") | Where-Object { $_ -match 'error' } | Select-Object -First 5 | ForEach-Object { Write-Host $_.TrimEnd("`r") }
                    Exit-Install "Could not create the admin account $AdminEmail. The stack is running; re-run this command to try again."
                }
                if ($otherAccounts -ne '0') {
                    # The Console created it as a regular user: the installer was asked for
                    # the admin, so it sets the role in the database (no Console script does).
                    [void](Get-MongoValue ('db.users.updateOne({ email: ''' + $AdminEmail + ''' }, { $set: { role: ''ADMIN'' } }).matchedCount'))
                    Write-InstallLog "The Console already had $otherAccounts account(s), so it made $AdminEmail a regular user; the installer set its role to ADMIN."
                }
                $role = Get-AccountRole $AdminEmail
                if ($role -ne 'ADMIN') {
                    Exit-Install "The account $AdminEmail was created, but its role is $role, not ADMIN. Make it an admin with: $(Get-PromoteCommand $AdminEmail)"
                }
                $signIn = Confirm-AdminSignIn "http://127.0.0.1:$consolePort/api/auth/login" $AdminEmail $adminSecret "http://localhost:$consolePort" "Set-Location -LiteralPath $dirQ; docker compose exec console npm run reset-password"
                $adminSecret = ''
                if ($signIn -eq 'ok') { Write-InstallLog "Signed in to the Console as ${AdminEmail}: the password works." }
                Write-FileAtomic $adminMarker "$AdminEmail (username $adminUsername, role ADMIN)`n"
                Write-InstallLog "Admin account created: $AdminEmail (username $adminUsername, role ADMIN)"
            }
        }
        $adminSecret = ''

        # ---------------------------------------------------------------------
        # Done
        Write-Host ''
        Write-Host 'MindStone is running.'
        Write-Host ''
        Write-Host "  Open http://localhost:$consolePort"
        switch ($adminStatus) {
            'generated' {
                Write-Host "  Sign in as $AdminEmail. The password is in $passwordFile (readable by you only)."
                Write-Host "  Read it from there, then delete the file once you've stored it somewhere safe."
            }
            'asked' { Write-Host "  Sign in as $AdminEmail with the password you chose." }
            'exists' {
                if ($existingRole -eq 'ADMIN') {
                    Write-Host @"
  An admin account with the email $AdminEmail already exists in this Console,
  so no account was created and no password was set. Sign in with its own
  password. If you've lost it:
    Set-Location -LiteralPath $dirQ; docker compose exec console npm run reset-password
"@
                } else {
                    Write-Host @"
  An account with the email $AdminEmail already exists in this Console as a
  regular user (role $existingRole), so no account was created and no password
  was set. To make it an admin:
    $(Get-PromoteCommand $AdminEmail)
  Or re-run with another -AdminEmail: the installer then creates that account
  and makes it an admin.
"@
                }
            }
            'none' {
                Write-Host @"
  No admin account yet (no console to ask in, and no -AdminEmail). Create one:
    $runCommand$dirArg -AdminEmail you@example.com
"@
            }
        }
        if ($profiles -like '*ollama*' -and $gatewayOllamaUrl -eq $StackOllamaUrl) {
            Write-Host @"

  Ollama runs in the stack (service ollama), reached by the gateway as $gatewayOllamaUrl.
  Pull a chat model with: Set-Location -LiteralPath $dirQ; docker compose exec ollama ollama pull <model>
  Back to Ollama on this machine: run the install command again with -WithoutOllama.
"@
        } elseif ($profiles -like '*ollama*') {
            Write-Host @"

  Ollama also runs in the stack (service ollama), but the gateway uses $gatewayOllamaUrl.
  To use the stack's Ollama, re-run with -WithOllama; to stop it, with -WithoutOllama.
"@
        } else {
            Write-Host ''
            Write-Host "  Ollama is reached by the gateway as $gatewayOllamaUrl."
        }
        if ($previousOllamaUrl -and $previousOllamaUrl -ne $gatewayOllamaUrl) {
            Write-Host @"
  The Ollama address changed (it was $previousOllamaUrl). If setup is already
  done, change the Ollama provider's address to $gatewayOllamaUrl in the Console
  (Settings, Your setup, model provider): chat keeps the address it was set up
  with, while memory follows the new one.
"@
        }
        $updateCommand = "irm $InstallUrl | iex"
        if ($dirArg) { $updateCommand = "$runCommand$dirArg" }
        Write-Host @"

  The Console shows a "Set up MindStone" banner until guided setup is done: it
  picks the model, the persona and memory.

Manage it (in $($S.InstallDir); plain docker compose there reads .env, but a
COMPOSE_* or OLLAMA_BASE_URL set in this session overrides it, so remove those first):
  Status:     Set-Location -LiteralPath $dirQ; docker compose ps
  Logs:       Set-Location -LiteralPath $dirQ; docker compose logs -f gateway
  CLI:        Set-Location -LiteralPath $dirQ; docker compose exec gateway ./scripts/mindstone status
  Stop:       Set-Location -LiteralPath $dirQ; docker compose stop
  Start:      Set-Location -LiteralPath $dirQ; docker compose up -d
  Customise:  put your changes in $([IO.Path]::Combine($S.InstallDir, 'compose.override.yml')) (never overwritten)
  Update:     $updateCommand
              (the same refs and ports as now; secrets and data are kept)
  Uninstall:  $runCommand$dirArg -Uninstall
              (stops the stack; data is kept, and it says how to delete it)
"@
    } catch {
        $adminSecret = ''
        $exception = $_.Exception
        while ($null -ne $exception -and -not $exception.Data.Contains('MindStoneInstallError')) { $exception = $exception.InnerException }
        if ($null -eq $exception) { throw }
        Write-Host '[MindStone install error] ' -ForegroundColor Red -NoNewline
        Write-Host $exception.Message
        # A script-terminating error, so powershell -File and -Command exit non-zero,
        # while an irm | iex session stays open (never exit, which would close it).
        throw 'The MindStone install stopped; see the message above.'
    }
}

Install-MindStoneStack @args -EndOfScript 'yes'

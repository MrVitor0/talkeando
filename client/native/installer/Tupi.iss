; Inno Setup recipe for the distributable Windows v1 installer.
; Build input: dotnet publish Talkeando.Client.csproj -c Release -r win-x64
; The build pipeline supplies AppVersion and PublishDir; no secrets belong here.

#define AppName "Tupi"
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\Talkeando.Client\bin\Release\net6.0-windows10.0.19041.0\win-x64\publish"
#endif

[Setup]
AppId={{C4DAA7EE-29E3-46D0-95F3-83464A9CD006}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Tupi
DefaultDirName={autopf}\Tupi
DefaultGroupName=Tupi
OutputDir=output
OutputBaseFilename=Tupi-Setup-{#AppVersion}-x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=yes
UninstallDisplayIcon={app}\Tupi.exe

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; Download the evergreen WebView2 Runtime only when the target machine lacks it.
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Icons]
Name: "{autoprograms}\Tupi"; Filename: "{app}\Tupi.exe"
Name: "{autodesktop}\Tupi"; Filename: "{app}\Tupi.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; Flags: unchecked

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; Flags: waituntilterminated skipifdoesntexist; Check: not WebViewRuntimeInstalled
Filename: "{app}\Tupi.exe"; Description: "Abrir Tupi"; Flags: nowait postinstall skipifsilent

[Code]
// GUID verified against a real WebView2 Runtime install (2026-08-27):
// `reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"`
// -> name "Microsoft Edge WebView2 Runtime". An earlier, unverified GUID
// here ({F1E5C0A9-...}) matched nothing on a real machine and would have
// made this check always report "not installed" — see SDD/27-decisions.md.
function WebViewRuntimeInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
            RegKeyExists(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not WebViewRuntimeInstalled and not FileExists(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe')) then
    Result := 'O WebView2 Runtime é necessário. Inclua MicrosoftEdgeWebview2Setup.exe ao gerar o instalador.';
end;

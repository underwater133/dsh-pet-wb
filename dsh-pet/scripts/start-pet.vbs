' dsh-pet launcher (Windows) - double-click entry, no console window.
' Locates start-pet.ps1 next to this file and runs it hidden.
' Keep this file in the same folder as start-pet.ps1.
Option Explicit

Dim fso, sh, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "start-pet.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "start-pet.ps1 not found next to this file." & vbCrLf & vbCrLf & _
         "Expected: " & ps1, 16, "dsh-pet"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Notify"
sh.Run cmd, 0, False

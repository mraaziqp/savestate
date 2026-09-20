' NexusEmu Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
strPath = WScript.ScriptFullName
Set FSO = CreateObject("Scripting.FileSystemObject")
Set Folder = FSO.GetFile(strPath).ParentFolder

cmd = "node.exe """ & Folder.Path & "\server.mjs"""
WshShell.Run cmd, 0, False
Set WshShell = Nothing

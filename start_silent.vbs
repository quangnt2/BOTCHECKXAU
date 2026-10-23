Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
strDir = FSO.GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = strDir
' Chay start_bot.bat an hoan toan duoi nen (window style = 0)
WshShell.Run "cmd /c """ & strDir & "\start_bot.bat""", 0, False

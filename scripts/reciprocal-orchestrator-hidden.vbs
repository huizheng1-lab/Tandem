Option Explicit

Dim arguments
Set arguments = WScript.Arguments

If arguments.Count < 2 Then
  WScript.Echo "Usage: reciprocal-orchestrator-hidden.vbs <node.exe> <script.mjs> [args...]"
  WScript.Quit 64
End If

Dim command, index
command = QuoteArgument(arguments.Item(0))
For index = 1 To arguments.Count - 1
  command = command & " " & QuoteArgument(arguments.Item(index))
Next

Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
  QuoteArgument = """" & Replace(CStr(value), """", """""") & """"
End Function
